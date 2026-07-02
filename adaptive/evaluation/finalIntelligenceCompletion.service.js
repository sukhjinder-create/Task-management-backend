import pool from "../../db.js";
import { recordLearningSignal } from "../learning/learningEngine.service.js";
import { businessCategoryForAction, capabilityLabel } from "./adaptiveIntelligenceEvaluation.service.js";

const DEFAULT_DAYS = 30;
const MIN_COACH_SAMPLES = 3;
const MIN_PATTERN_SAMPLES = 3;
const EXPLAINABILITY_MODEL = "universal_explainability_v1";

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function average(values, fallback = null) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return fallback;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return Object.values(value).filter(Boolean);
  return [value];
}

function text(value) {
  return String(value || "").trim();
}

function percent(value) {
  const number = Number(value || 0);
  return `${Math.round(number * 100)}%`;
}

function boundedDays(days) {
  return Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), 365);
}

function responseFromRecord(record = {}) {
  const stage = safeArray(record.lifecycle?.stages).find((item) => item.label === "User response");
  const response = String(stage?.value || JSON.stringify(record.lifecycle || {}) || "pending").toLowerCase();
  if (response.includes("executed")) return "executed";
  if (response.includes("accepted")) return "accepted";
  if (response.includes("approved")) return "accepted";
  if (response.includes("rejected")) return "rejected";
  if (response.includes("ignored")) return "ignored";
  return "pending";
}

function groupStats(records = [], keyFn) {
  const map = new Map();
  for (const record of records) {
    const keys = safeArray(keyFn(record)).filter(Boolean);
    for (const key of keys) {
      const entry = map.get(key) || {
        label: key,
        count: 0,
        scoreTotal: 0,
        accepted: 0,
        rejected: 0,
        ignored: 0,
        pending: 0,
        executed: 0,
      };
      const responseText = JSON.stringify([record.status, record.lifecycle, record.explainability || {}]).toLowerCase();
      const response = responseText.includes("rejected") ? "rejected"
        : responseText.includes("ignored") ? "ignored"
          : responseText.includes("executed") ? "executed"
            : responseText.includes("accepted") || responseText.includes("approved") ? "accepted"
              : responseFromRecord(record);
      entry.count += 1;
      entry.scoreTotal += Number(record.effectiveness_score || 0);
      entry[response] = Number(entry[response] || 0) + 1;
      map.set(key, entry);
    }
  }
  return [...map.values()]
    .map((entry) => ({
      ...entry,
      averageEffectiveness: round(entry.scoreTotal / Math.max(entry.count, 1), 4),
      acceptanceRate: round((entry.accepted + entry.executed) / Math.max(entry.count, 1), 4),
      rejectionRate: round((entry.rejected + entry.ignored) / Math.max(entry.count, 1), 4),
    }))
    .sort((left, right) => right.averageEffectiveness - left.averageEffectiveness || right.count - left.count);
}

function summarize(records = []) {
  const responses = records.reduce((acc, record) => {
    const response = responseFromRecord(record);
    acc[response] = Number(acc[response] || 0) + 1;
    return acc;
  }, { accepted: 0, executed: 0, rejected: 0, ignored: 0, pending: 0 });
  const calibration = records.reduce((acc, record) => {
    acc.evaluated += Number(record.confidence_calibration?.evaluated || 0);
    acc.falsePositives += Number(record.confidence_calibration?.falsePositives || 0);
    acc.falseNegatives += Number(record.confidence_calibration?.falseNegatives || 0);
    acc.overconfident += Number(record.confidence_calibration?.overconfident || 0);
    acc.underconfident += Number(record.confidence_calibration?.underconfident || 0);
    return acc;
  }, { evaluated: 0, falsePositives: 0, falseNegatives: 0, overconfident: 0, underconfident: 0 });
  const total = records.length;
  return {
    total,
    averageEffectiveness: round(average(records.map((record) => record.effectiveness_score), 0), 4),
    acceptanceRate: round((responses.accepted + responses.executed) / Math.max(total, 1), 4),
    rejectionRate: round((responses.rejected + responses.ignored) / Math.max(total, 1), 4),
    responses,
    calibration,
    categories: groupStats(records, (record) => record.recommendation_category || "Operational assistance"),
    capabilities: groupStats(records, (record) => safeArray(record.capability_summary).map((item) => item.label)),
    contexts: groupStats(records, (record) => safeArray(record.context_summary).map((item) => item.label)),
  };
}

function insightKey(type, label) {
  return `${type}:${text(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "workspace"}`;
}

export function buildCoachInsights({ currentRecords = [], previousRecords = [], scopeLabel = "this workspace" } = {}) {
  const current = summarize(currentRecords);
  const previous = summarize(previousRecords);
  const insights = [];
  const acceptanceDelta = current.acceptanceRate - previous.acceptanceRate;
  const effectivenessDelta = current.averageEffectiveness - previous.averageEffectiveness;

  if (current.total === 0) {
    insights.push({
      insightKey: "readiness:no_evaluated_recommendations",
      type: "opportunity",
      severity: "attention",
      title: "Adaptive Intelligence needs more evaluated outcomes",
      summary: `AIEP found 0 evaluated recommendations for ${scopeLabel} in the selected window.`,
      evidence: ["0 evaluated recommendation lifecycles were available in the selected window."],
      recommendedActions: ["Let recommendations mature through approval, execution, and feedback before judging strategy quality."],
      expectedBusinessImpact: "More evaluated outcomes will make future coach guidance specific and measurable.",
      confidence: 0.5,
    });
    return insights;
  }

  if (Math.abs(acceptanceDelta) >= 0.1 && previous.total >= MIN_COACH_SAMPLES) {
    const direction = acceptanceDelta > 0 ? "increased" : "decreased";
    insights.push({
      insightKey: insightKey("trend_acceptance", direction),
      type: acceptanceDelta > 0 ? "strength" : "weakness",
      severity: acceptanceDelta > 0 ? "positive" : "attention",
      title: `Recommendation acceptance ${direction}`,
      summary: `Recommendation acceptance has ${direction} by ${percent(Math.abs(acceptanceDelta))} compared with the previous ${previous.total}-recommendation window.`,
      evidence: [
        `Current acceptance: ${percent(current.acceptanceRate)} across ${current.total} evaluated recommendations.`,
        `Previous acceptance: ${percent(previous.acceptanceRate)} across ${previous.total} evaluated recommendations.`,
      ],
      recommendedActions: acceptanceDelta > 0
        ? ["Review the highest-performing strategies and keep their timing/context patterns active."]
        : ["Inspect low-performing categories and reduce noisy recommendation timing before increasing automation."],
      expectedBusinessImpact: acceptanceDelta > 0
        ? "Sustaining accepted recommendations should improve user trust and workflow adoption."
        : "Reducing poorly timed or low-value recommendations should improve trust and reduce manager fatigue.",
      confidence: clamp(Math.min(current.total, previous.total) / 30, 0.35, 0.95),
    });
  }

  if (Math.abs(effectivenessDelta) >= 0.08 && previous.total >= MIN_COACH_SAMPLES) {
    insights.push({
      insightKey: insightKey("trend_effectiveness", effectivenessDelta > 0 ? "up" : "down"),
      type: effectivenessDelta > 0 ? "strength" : "weakness",
      severity: effectivenessDelta > 0 ? "positive" : "attention",
      title: effectivenessDelta > 0 ? "Business effectiveness improved" : "Business effectiveness weakened",
      summary: `Average recommendation effectiveness moved from ${percent(previous.averageEffectiveness)} to ${percent(current.averageEffectiveness)}.`,
      evidence: [
        `Current effectiveness: ${percent(current.averageEffectiveness)}.`,
        `Previous effectiveness: ${percent(previous.averageEffectiveness)}.`,
      ],
      recommendedActions: effectivenessDelta > 0
        ? ["Preserve the strategy mix that produced the improvement."]
        : ["Run a controlled experiment before changing workflow timing or approval policy."],
      expectedBusinessImpact: "Keeping strategy changes evidence-based protects delivery outcomes while improving adoption.",
      confidence: clamp(Math.min(current.total, previous.total) / 25, 0.35, 0.9),
    });
  }

  const bestCategory = current.categories.find((item) => item.count >= MIN_COACH_SAMPLES && item.averageEffectiveness >= 0.67);
  if (bestCategory) {
    insights.push({
      insightKey: insightKey("category_strength", bestCategory.label),
      type: "strength",
      severity: "positive",
      title: `${bestCategory.label} is producing strong outcomes`,
      summary: `${bestCategory.label} recommendations averaged ${percent(bestCategory.averageEffectiveness)} effectiveness across ${bestCategory.count} evaluated cases.`,
      evidence: [
        `${bestCategory.count} evaluated recommendations in this category.`,
        `${percent(bestCategory.acceptanceRate)} were accepted or executed.`,
      ],
      recommendedActions: [`Use ${bestCategory.label.toLowerCase()} as the benchmark when designing future strategies.`],
      expectedBusinessImpact: "Scaling high-performing patterns should improve delivery confidence without changing core orchestration.",
      confidence: clamp(bestCategory.count / 20, 0.45, 0.95),
    });
  }

  const weakCategory = [...current.categories].reverse().find((item) => item.count >= MIN_COACH_SAMPLES && (item.averageEffectiveness <= 0.45 || item.rejectionRate >= 0.5));
  if (weakCategory) {
    insights.push({
      insightKey: insightKey("category_weakness", weakCategory.label),
      type: "weakness",
      severity: "attention",
      title: `${weakCategory.label} needs strategy review`,
      summary: `${weakCategory.label} averaged ${percent(weakCategory.averageEffectiveness)} effectiveness and ${percent(weakCategory.rejectionRate)} rejection/ignore rate across ${weakCategory.count} cases.`,
      evidence: [
        `${weakCategory.count} evaluated recommendations in this category.`,
        `${percent(weakCategory.rejectionRate)} were rejected or ignored.`,
      ],
      recommendedActions: ["Reduce frequency, adjust timing, or compare an alternate workflow sequence through an experiment."],
      expectedBusinessImpact: "Improving weak categories should reduce alert fatigue and increase adoption of genuinely helpful recommendations.",
      confidence: clamp(weakCategory.count / 20, 0.45, 0.95),
    });
  }

  const bestContext = current.contexts.find((item) => item.count >= MIN_COACH_SAMPLES && item.averageEffectiveness >= 0.67);
  const weakContext = [...current.contexts].reverse().find((item) => item.count >= MIN_COACH_SAMPLES && item.averageEffectiveness <= 0.45);
  if (bestContext && weakContext && bestContext.label !== weakContext.label) {
    insights.push({
      insightKey: insightKey("context_opportunity", `${bestContext.label}_${weakContext.label}`),
      type: "opportunity",
      severity: "info",
      title: `${bestContext.label} is more useful than ${weakContext.label}`,
      summary: `${bestContext.label} contributed to ${percent(bestContext.averageEffectiveness)} effectiveness, while ${weakContext.label} contributed to ${percent(weakContext.averageEffectiveness)}.`,
      evidence: [
        `${bestContext.label}: ${bestContext.count} measured uses.`,
        `${weakContext.label}: ${weakContext.count} measured uses.`,
      ],
      recommendedActions: [`Improve ${weakContext.label.toLowerCase()} quality before increasing its influence.`],
      expectedBusinessImpact: "Better context quality should improve recommendation precision and reduce weak suggestions.",
      confidence: clamp(Math.min(bestContext.count, weakContext.count) / 20, 0.45, 0.9),
    });
  }

  if (current.calibration.evaluated >= MIN_COACH_SAMPLES && (current.calibration.falsePositives > 0 || current.calibration.overconfident > current.calibration.underconfident)) {
    insights.push({
      insightKey: "calibration:overconfidence",
      type: "anomaly",
      severity: "attention",
      title: "Confidence calibration needs attention",
      summary: `AIEP found ${current.calibration.falsePositives} false-positive and ${current.calibration.overconfident} overconfident prediction case(s).`,
      evidence: [
        `${current.calibration.evaluated} evaluated predictions in the selected window.`,
        `${current.calibration.falsePositives} high-confidence predictions did not produce the expected outcome.`,
      ],
      recommendedActions: ["Require more evidence before high-confidence automation in weak categories."],
      expectedBusinessImpact: "Better calibration protects user trust and reduces low-value automation.",
      confidence: clamp(current.calibration.evaluated / 30, 0.45, 0.95),
    });
  }

  if (!insights.length) {
    insights.push({
      insightKey: "stability:no_major_anomaly",
      type: "strength",
      severity: "info",
      title: "Adaptive Intelligence is stable",
      summary: `${scopeLabel} has ${current.total} evaluated recommendations with ${percent(current.averageEffectiveness)} average effectiveness and no major trend anomaly.`,
      evidence: [
        `${current.total} evaluated recommendations.`,
        `${percent(current.acceptanceRate)} acceptance rate.`,
      ],
      recommendedActions: ["Continue collecting outcomes before making strategy changes."],
      expectedBusinessImpact: "Avoiding unnecessary changes preserves stable operational behaviour.",
      confidence: clamp(current.total / 20, 0.4, 0.9),
    });
  }

  return insights;
}

function variantMatchesRecord(variant = {}, record = {}) {
  const filter = variant.filter || {};
  if (filter.recommendationCategory && record.recommendation_category !== filter.recommendationCategory) return false;
  if (filter.capabilityLabel) {
    const labels = safeArray(record.capability_summary).map((item) => item.label);
    if (!labels.includes(filter.capabilityLabel)) return false;
  }
  if (filter.contextLabel) {
    const labels = safeArray(record.context_summary).map((item) => item.label);
    if (!labels.includes(filter.contextLabel)) return false;
  }
  if (filter.approvalApproach && record.strategy_summary?.approvalApproach !== filter.approvalApproach) return false;
  return true;
}

function metricForRecord(record = {}, metric = "effectiveness") {
  if (metric === "adoption") {
    return ["accepted", "executed"].includes(responseFromRecord(record)) ? 1 : 0;
  }
  if (metric === "approval_efficiency") {
    const latency = Number(record.business_outcomes?.decisionLatencyMinutes);
    return Number.isFinite(latency) ? clamp(1 - (latency / 1440), 0, 1) : null;
  }
  if (metric === "delivery") {
    const delivery = safeArray(record.business_outcomes?.dimensions).find((item) => item.label === "Delivery");
    return Number.isFinite(Number(delivery?.score)) ? Number(delivery.score) : null;
  }
  return Number(record.effectiveness_score);
}

export function evaluateExperimentVariants({ experiment = {}, records = [] } = {}) {
  const variants = safeArray(experiment.variants);
  const primaryMetric = experiment.primary_metric || experiment.primaryMetric || "effectiveness";
  const minSample = Number(experiment.minimum_sample_size ?? experiment.minimumSampleSize ?? 20);
  const meaningfulDelta = Number(experiment.meaningful_delta ?? experiment.meaningfulDelta ?? 0.08);
  const variantResults = variants.map((variant) => {
    const matched = records.filter((record) => variantMatchesRecord(variant, record));
    const metricValues = matched.map((record) => metricForRecord(record, primaryMetric)).filter((value) => Number.isFinite(Number(value)));
    const adoptionValues = matched.map((record) => metricForRecord(record, "adoption")).filter((value) => Number.isFinite(Number(value)));
    return {
      key: variant.key,
      label: variant.label || variant.key,
      sampleCount: matched.length,
      primaryMetric,
      score: round(average(metricValues, 0), 4),
      adoptionRate: round(average(adoptionValues, 0), 4),
      averageEffectiveness: round(average(matched.map((record) => record.effectiveness_score), 0), 4),
      evidence: [
        `${matched.length} matching recommendation lifecycle(s).`,
        `${metricValues.length} measurable ${primaryMetric} value(s).`,
      ],
    };
  }).sort((left, right) => right.score - left.score || right.sampleCount - left.sampleCount);
  const [winner, runnerUp] = variantResults;
  const meaningfulEvidence = variantResults.length >= 2
    && variantResults.every((result) => result.sampleCount >= minSample)
    && (Number(winner?.score || 0) - Number(runnerUp?.score || 0)) >= meaningfulDelta;
  return {
    variantResults,
    recommendation: {
      meaningfulEvidence,
      winner: meaningfulEvidence ? { key: winner.key, label: winner.label } : null,
      summary: meaningfulEvidence
        ? `${winner.label} is outperforming ${runnerUp.label} by ${percent(Number(winner.score || 0) - Number(runnerUp.score || 0))} on ${primaryMetric}.`
        : "No strategy should be promoted yet because the experiment does not have enough meaningful evidence.",
      expectedBusinessImpact: meaningfulEvidence
        ? "Promoting the winning strategy should improve measured business outcomes while preserving reversibility."
        : "Waiting protects the workspace from premature strategy changes.",
    },
    dataQuality: {
      minimumSampleSize: minSample,
      meaningfulDelta,
      enoughEvidence: meaningfulEvidence,
    },
  };
}

export function discoverMemoryPatternsFromEvidence({ evaluations = [], learningSignals = [] } = {}) {
  const patterns = [];
  const categoryStats = groupStats(evaluations, (record) => record.recommendation_category || "Operational assistance");
  for (const item of categoryStats) {
    if (item.count >= MIN_PATTERN_SAMPLES && item.rejectionRate >= 0.5) {
      patterns.push({
        patternKey: insightKey("category_rejection", item.label),
        patternType: "behavioural_preference",
        businessLabel: item.label,
        patternSummary: `${item.label} recommendations are often rejected or ignored in this workspace.`,
        evidence: [
          `${item.count} measured recommendation(s).`,
          `${percent(item.rejectionRate)} rejected or ignored.`,
          `${percent(item.averageEffectiveness)} average effectiveness.`,
        ],
        recommendedUse: "Reduce frequency or test a different timing/approval strategy before increasing automation.",
        direction: "avoid",
        confidence: clamp(item.count / 20, 0.45, 0.95),
        sampleCount: item.count,
      });
    }
    if (item.count >= MIN_PATTERN_SAMPLES && item.averageEffectiveness >= 0.68 && item.acceptanceRate >= 0.6) {
      patterns.push({
        patternKey: insightKey("category_success", item.label),
        patternType: "successful_strategy",
        businessLabel: item.label,
        patternSummary: `${item.label} recommendations are consistently useful in this workspace.`,
        evidence: [
          `${item.count} measured recommendation(s).`,
          `${percent(item.acceptanceRate)} accepted or executed.`,
          `${percent(item.averageEffectiveness)} average effectiveness.`,
        ],
        recommendedUse: "Prefer this strategy when similar operational evidence appears.",
        direction: "prefer",
        confidence: clamp(item.count / 20, 0.45, 0.95),
        sampleCount: item.count,
      });
    }
  }

  const contextStats = groupStats(evaluations, (record) => safeArray(record.context_summary).map((item) => item.label));
  for (const item of contextStats) {
    if (item.count >= MIN_PATTERN_SAMPLES && item.averageEffectiveness <= 0.45) {
      patterns.push({
        patternKey: insightKey("context_low_value", item.label),
        patternType: "context_quality",
        businessLabel: item.label,
        patternSummary: `${item.label} context rarely improves recommendation quality in current evidence.`,
        evidence: [
          `${item.count} measured use(s) of this context.`,
          `${percent(item.averageEffectiveness)} average effectiveness.`,
        ],
        recommendedUse: "Improve source quality or indexing before increasing its influence.",
        direction: "improve",
        confidence: clamp(item.count / 20, 0.4, 0.9),
        sampleCount: item.count,
      });
    }
  }

  const afterHoursGroups = new Map();
  for (const signal of learningSignals) {
    const createdAt = new Date(signal.action_created_at || signal.created_at);
    const hour = createdAt.getHours();
    const role = signal.actor_role || "team members";
    const category = businessCategoryForAction(signal);
    const negative = ["recommendation.rejected", "recommendation.ignored", "execution.failed"].includes(signal.signal_key);
    if (hour < 17 || !negative) continue;
    const key = `${role}:${category}`;
    const entry = afterHoursGroups.get(key) || { role, category, count: 0 };
    entry.count += 1;
    afterHoursGroups.set(key, entry);
  }
  for (const entry of afterHoursGroups.values()) {
    if (entry.count >= MIN_PATTERN_SAMPLES) {
      patterns.push({
        patternKey: insightKey("after_hours_rejection", `${entry.role}_${entry.category}`),
        patternType: "timing_preference",
        businessLabel: `${entry.category} after-hours timing`,
        patternSummary: `${entry.role} often reject or ignore ${entry.category.toLowerCase()} recommendations after 5 PM.`,
        evidence: [`${entry.count} negative after-hours feedback signal(s).`],
        recommendedUse: "Prefer next-business-window delivery unless the risk is high or critical.",
        direction: "avoid",
        confidence: clamp(entry.count / 12, 0.45, 0.9),
        sampleCount: entry.count,
      });
    }
  }

  return patterns;
}

export function buildUniversalExplanation({ action = {}, evaluation = null, memoryPatterns = [], similarEvaluations = [] } = {}) {
  const category = evaluation?.recommendation_category || businessCategoryForAction(action);
  const context = safeArray(evaluation?.context_summary).map((item) => item.label || item);
  const learning = safeArray(evaluation?.learning_summary?.learningChanges);
  const confidence = round(
    evaluation?.explainability?.predictedConfidence
      ?? action.outcome_confidence
      ?? action.prediction_confidence
      ?? action.confidence
      ?? null,
    3
  );
  const similar = similarEvaluations.slice(0, 3).map((item) => ({
    situation: item.recommendation_category || "Similar adaptive recommendation",
    outcome: item.explainability?.outcome || "Outcome evidence was recorded.",
    effectiveness: round(item.effectiveness_score, 3),
  }));
  const activePatterns = memoryPatterns.slice(0, 5).map((pattern) => ({
    pattern: pattern.pattern_summary,
    confidence: round(pattern.confidence, 3),
    use: pattern.recommended_use,
  }));
  const visible = {
    subject: category,
    whyRecommended: evaluation?.explainability?.whyRecommended || action.explanation || action.summary || "Asystence detected an operational pattern that may need attention.",
    contextInfluences: context.length ? context : ["Operational history"],
    historicalBehaviour: activePatterns.length
      ? activePatterns
      : [{ pattern: "No strong historical pattern has been discovered for this recommendation yet.", confidence: null, use: "Continue collecting feedback." }],
    learningSignals: learning.length ? learning : ["No material learning change has been recorded yet."],
    confidence: confidence === null ? "Not enough confidence evidence yet" : percent(confidence),
    expectedBusinessOutcome: evaluation?.explainability?.outcome || "Expected business outcome will be measured through AIEP once the recommendation matures.",
    similarHistoricalSituations: similar.length ? similar : [{ situation: "No similar evaluated situation found yet.", outcome: "AIEP will compare future similar recommendations.", effectiveness: null }],
    previousFeedbackChanges: evaluation?.learning_summary?.explanation || "Previous feedback is tracked as reversible learning signals.",
    wouldRecommendationChangeToday: evaluation?.explainability?.wouldRecommendAgain === false
      ? "Yes. Current evidence suggests this recommendation should be reviewed before repeating."
      : "Not materially. Current evidence supports repeating this recommendation when similar conditions appear.",
    businessEvidence: [
      ...(evaluation?.business_outcomes?.dimensions || []).slice(0, 4).map((item) => `${item.label}: ${percent(item.score)}.`),
      `${similarEvaluations.length} similar evaluated situation(s) were considered.`,
    ],
    generatedBy: EXPLAINABILITY_MODEL,
  };
  const serialized = JSON.stringify(visible);
  return serialized
    .replace(/[a-z_]+\.[a-z_]+/g, "adaptive capability")
    .replace(/recommendation\.[a-z_]+/g, "recommendation feedback");
}

async function loadEvaluationRecords({ workspaceId = null, days = DEFAULT_DAYS, previous = false, limit = 500 } = {}) {
  const bounded = boundedDays(days);
  const params = [];
  const where = [];
  if (workspaceId) {
    params.push(workspaceId);
    where.push(`workspace_id = $${params.length}`);
  }
  if (previous) {
    params.push(bounded * 2);
    where.push(`evaluated_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    params.push(bounded);
    where.push(`evaluated_at < NOW() - ($${params.length}::int * INTERVAL '1 day')`);
  } else {
    params.push(bounded);
    where.push(`evaluated_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
  }
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 5000));
  const { rows } = await pool.query(
    `SELECT *
     FROM adaptive_intelligence_evaluations
     WHERE ${where.join(" AND ")}
     ORDER BY evaluated_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function replaceActiveCoachInsights({ workspaceId = null, scopeType, scopeId = null, insights, days }) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - boundedDays(days) * 86400000);
  const saved = [];
  for (const insight of insights) {
    await pool.query(
      `UPDATE adaptive_intelligence_coach_insights
       SET status = 'archived', updated_at = NOW()
       WHERE workspace_id IS NOT DISTINCT FROM $1::uuid
         AND scope_type = $2
         AND scope_id IS NOT DISTINCT FROM $3::uuid
         AND insight_key = $4
         AND status = 'active'`,
      [workspaceId, scopeType, scopeId, insight.insightKey]
    );
    const { rows } = await pool.query(
      `
      INSERT INTO adaptive_intelligence_coach_insights (
        workspace_id, scope_type, scope_id, insight_key, insight_type, severity,
        title, summary, evidence, recommended_actions, expected_business_impact,
        confidence, window_start, window_end
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
      RETURNING *
      `,
      [
        workspaceId,
        scopeType,
        scopeId,
        insight.insightKey,
        insight.type,
        insight.severity,
        insight.title,
        insight.summary,
        JSON.stringify(insight.evidence || []),
        JSON.stringify(insight.recommendedActions || []),
        insight.expectedBusinessImpact || null,
        clamp(insight.confidence ?? 0.5),
        windowStart,
        windowEnd,
      ]
    );
    saved.push(rows[0]);
  }
  return saved;
}

export async function getWorkspaceAdaptiveCoach({ workspaceId, days = DEFAULT_DAYS } = {}) {
  const [currentRecords, previousRecords] = await Promise.all([
    loadEvaluationRecords({ workspaceId, days, limit: 1000 }),
    loadEvaluationRecords({ workspaceId, days, previous: true, limit: 1000 }),
  ]);
  const insights = buildCoachInsights({ currentRecords, previousRecords, scopeLabel: "this workspace" });
  const saved = await replaceActiveCoachInsights({ workspaceId, scopeType: "workspace", insights, days });
  return {
    scope: "workspace",
    windowDays: boundedDays(days),
    generatedAt: new Date().toISOString(),
    insights: saved.map((row) => ({
      id: row.id,
      type: row.insight_type,
      severity: row.severity,
      title: row.title,
      summary: row.summary,
      evidence: row.evidence,
      recommendedActions: row.recommended_actions,
      expectedBusinessImpact: row.expected_business_impact,
      confidence: row.confidence,
    })),
    dataQuality: {
      currentEvaluations: currentRecords.length,
      previousEvaluations: previousRecords.length,
      evidenceBased: true,
    },
  };
}

export async function getPlatformAdaptiveCoach({ days = DEFAULT_DAYS } = {}) {
  const [currentRecords, previousRecords] = await Promise.all([
    loadEvaluationRecords({ days, limit: 2000 }),
    loadEvaluationRecords({ days, previous: true, limit: 2000 }),
  ]);
  const insights = buildCoachInsights({ currentRecords, previousRecords, scopeLabel: "the platform" });
  const saved = await replaceActiveCoachInsights({ workspaceId: null, scopeType: "platform", insights, days });
  return {
    scope: "platform",
    windowDays: boundedDays(days),
    generatedAt: new Date().toISOString(),
    aggregateOnly: true,
    insights: saved.map((row) => ({
      id: row.id,
      type: row.insight_type,
      severity: row.severity,
      title: row.title,
      summary: row.summary,
      evidence: row.evidence,
      recommendedActions: row.recommended_actions,
      expectedBusinessImpact: row.expected_business_impact,
      confidence: row.confidence,
    })),
    dataQuality: {
      currentEvaluations: currentRecords.length,
      previousEvaluations: previousRecords.length,
      tenantSafe: true,
    },
  };
}

function normalizeExperimentPayload(payload = {}, { workspaceId, actorUserId = null, platform = false } = {}) {
  const variants = safeArray(payload.variants);
  if (variants.length < 2) throw new Error("At least two experiment variants are required");
  const cleanVariants = variants.map((variant, index) => ({
    key: text(variant.key || `variant_${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 80),
    label: text(variant.label || variant.key || `Variant ${index + 1}`).slice(0, 120),
    filter: variant.filter || {},
  }));
  return {
    workspaceId: platform ? null : workspaceId,
    scopeType: platform ? "platform" : (["workspace", "department", "pilot"].includes(payload.scopeType) ? payload.scopeType : "workspace"),
    scopeId: platform ? null : payload.scopeId || null,
    name: text(payload.name || "Adaptive strategy experiment").slice(0, 160),
    hypothesis: text(payload.hypothesis || "Compare adaptive strategies using measured business outcomes.").slice(0, 500),
    experimentType: text(payload.experimentType || "strategy_comparison").slice(0, 80),
    variants: cleanVariants,
    primaryMetric: ["effectiveness", "adoption", "approval_efficiency", "delivery"].includes(payload.primaryMetric) ? payload.primaryMetric : "effectiveness",
    secondaryMetrics: safeArray(payload.secondaryMetrics),
    minimumSampleSize: Math.min(Math.max(Number(payload.minimumSampleSize) || 20, 5), 10000),
    meaningfulDelta: clamp(payload.meaningfulDelta ?? 0.08, 0.01, 1),
    status: ["draft", "active", "paused"].includes(payload.status) ? payload.status : "draft",
    guardrails: payload.guardrails || { reversible: true, tenantIsolated: true },
    actorUserId,
  };
}

export async function createAdaptiveExperiment({ workspaceId, actorUserId, payload, platform = false } = {}) {
  const experiment = normalizeExperimentPayload(payload, { workspaceId, actorUserId, platform });
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_strategy_experiments (
      workspace_id, scope_type, scope_id, name, hypothesis, experiment_type,
      variants, primary_metric, secondary_metrics, minimum_sample_size,
      meaningful_delta, status, guardrails, created_by, started_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14,
      CASE WHEN $12 = 'active' THEN NOW() ELSE NULL END)
    RETURNING *
    `,
    [
      experiment.workspaceId,
      experiment.scopeType,
      experiment.scopeId,
      experiment.name,
      experiment.hypothesis,
      experiment.experimentType,
      JSON.stringify(experiment.variants),
      experiment.primaryMetric,
      JSON.stringify(experiment.secondaryMetrics),
      experiment.minimumSampleSize,
      experiment.meaningfulDelta,
      experiment.status,
      JSON.stringify(experiment.guardrails),
      experiment.actorUserId,
    ]
  );
  return rows[0];
}

export async function listAdaptiveExperiments({ workspaceId = null, platform = false, includeArchived = false } = {}) {
  const params = [];
  const where = [];
  if (platform) {
    where.push("workspace_id IS NULL");
  } else {
    params.push(workspaceId);
    where.push(`workspace_id = $${params.length}`);
  }
  if (!includeArchived) where.push("status != 'archived'");
  const { rows } = await pool.query(
    `SELECT *
     FROM adaptive_strategy_experiments
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT 100`,
    params
  );
  return rows;
}

export async function setAdaptiveExperimentStatus({ workspaceId = null, experimentId, status, platform = false } = {}) {
  if (!["draft", "active", "paused", "completed", "archived"].includes(status)) throw new Error("Invalid experiment status");
  const params = [status, experimentId];
  const where = ["id = $2"];
  if (platform) {
    where.push("workspace_id IS NULL");
  } else {
    params.push(workspaceId);
    where.push(`workspace_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `UPDATE adaptive_strategy_experiments
     SET status = $1,
         started_at = CASE WHEN $1 = 'active' AND started_at IS NULL THEN NOW() ELSE started_at END,
         ended_at = CASE WHEN $1 IN ('completed','archived') THEN NOW() ELSE ended_at END,
         updated_at = NOW()
     WHERE ${where.join(" AND ")}
     RETURNING *`,
    params
  );
  return rows[0] || null;
}

export async function evaluateAdaptiveExperiment({ workspaceId = null, experimentId, days = DEFAULT_DAYS, platform = false } = {}) {
  const params = [experimentId];
  const where = ["id = $1"];
  if (platform) {
    where.push("workspace_id IS NULL");
  } else {
    params.push(workspaceId);
    where.push(`workspace_id = $${params.length}`);
  }
  const { rows: experiments } = await pool.query(`SELECT * FROM adaptive_strategy_experiments WHERE ${where.join(" AND ")} LIMIT 1`, params);
  const experiment = experiments[0];
  if (!experiment) return null;
  const records = await loadEvaluationRecords({ workspaceId: platform ? null : workspaceId, days, limit: 3000 });
  const result = evaluateExperimentVariants({ experiment, records });
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - boundedDays(days) * 86400000);
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_strategy_experiment_results (
      experiment_id, workspace_id, window_start, window_end,
      variant_results, recommendation, data_quality
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
    RETURNING *
    `,
    [
      experiment.id,
      experiment.workspace_id,
      windowStart,
      windowEnd,
      JSON.stringify(result.variantResults),
      JSON.stringify(result.recommendation),
      JSON.stringify(result.dataQuality),
    ]
  );
  return { experiment, result: rows[0] };
}

async function loadLearningSignalsForPatterns({ workspaceId, days = DEFAULT_DAYS }) {
  const { rows } = await pool.query(
    `
    SELECT
      l.*,
      a.action_type,
      a.capability_key,
      a.title,
      a.summary,
      a.explanation,
      a.evidence,
      a.payload,
      a.created_at AS action_created_at,
      u.role AS actor_role
    FROM adaptive_learning_signals l
    LEFT JOIN operations_ai_actions a ON a.id = l.action_id AND a.workspace_id = l.workspace_id
    LEFT JOIN users u ON u.id = l.actor_user_id
    WHERE l.workspace_id = $1
      AND l.created_at >= NOW() - ($2::int * INTERVAL '1 day')
      AND l.status = 'active'
    ORDER BY l.created_at DESC
    LIMIT 1000
    `,
    [workspaceId, boundedDays(days)]
  );
  return rows;
}

async function upsertMemoryPattern({ workspaceId, pattern, actorUserId = null }) {
  const { rows: updated } = await pool.query(
    `
    UPDATE adaptive_memory_patterns
    SET pattern_summary = $1,
        business_label = $2,
        evidence = $3::jsonb,
        recommended_use = $4,
        direction = $5,
        confidence = $6,
        sample_count = $7,
        status = 'active',
        last_observed_at = NOW(),
        updated_at = NOW()
    WHERE workspace_id = $8
      AND scope_type = 'workspace'
      AND scope_id IS NULL
      AND pattern_key = $9
      AND status = 'active'
    RETURNING *
    `,
    [
      pattern.patternSummary,
      pattern.businessLabel,
      JSON.stringify(pattern.evidence || []),
      pattern.recommendedUse || null,
      pattern.direction,
      clamp(pattern.confidence ?? 0.5),
      Number(pattern.sampleCount || 0),
      workspaceId,
      pattern.patternKey,
    ]
  );
  const row = updated[0] || (await pool.query(
    `
    INSERT INTO adaptive_memory_patterns (
      workspace_id, scope_type, pattern_key, pattern_type, pattern_summary,
      business_label, evidence, recommended_use, direction, confidence,
      sample_count, last_observed_at
    ) VALUES ($1,'workspace',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,NOW())
    RETURNING *
    `,
    [
      workspaceId,
      pattern.patternKey,
      pattern.patternType,
      pattern.patternSummary,
      pattern.businessLabel,
      JSON.stringify(pattern.evidence || []),
      pattern.recommendedUse || null,
      pattern.direction,
      clamp(pattern.confidence ?? 0.5),
      Number(pattern.sampleCount || 0),
    ]
  )).rows[0];

  await recordLearningSignal({
    workspaceId,
    scopeType: "workspace",
    signalKey: "memory.pattern.discovered",
    signalValue: {
      patternId: row.id,
      patternKey: row.pattern_key,
      direction: row.direction,
      businessLabel: row.business_label,
      recommendedUse: row.recommended_use,
      confidence: row.confidence,
    },
    source: "adaptive_memory_evolution",
    actorUserId,
    confidence: row.confidence,
    idempotencyKey: `memory-pattern:${row.id}:${row.updated_at?.toISOString?.() || row.updated_at}`,
  }).catch((error) => {
    console.warn("[adaptive memory] learning signal could not be recorded:", error.message);
  });
  return row;
}

export async function discoverWorkspaceMemoryPatterns({ workspaceId, actorUserId = null, days = DEFAULT_DAYS } = {}) {
  const [evaluations, learningSignals] = await Promise.all([
    loadEvaluationRecords({ workspaceId, days, limit: 1000 }),
    loadLearningSignalsForPatterns({ workspaceId, days }),
  ]);
  const patterns = discoverMemoryPatternsFromEvidence({ evaluations, learningSignals });
  const saved = [];
  for (const pattern of patterns) {
    saved.push(await upsertMemoryPattern({ workspaceId, pattern, actorUserId }));
  }
  return {
    discovered: saved.length,
    patterns: saved,
    dataQuality: {
      evaluatedRecommendations: evaluations.length,
      learningSignals: learningSignals.length,
      evidenceBased: true,
    },
  };
}

export async function listWorkspaceMemoryPatterns({ workspaceId, includeArchived = false } = {}) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM adaptive_memory_patterns
    WHERE workspace_id = $1
      ${includeArchived ? "" : "AND status = 'active'"}
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 100
    `,
    [workspaceId]
  );
  return rows;
}

export async function reverseWorkspaceMemoryPattern({ workspaceId, patternId, actorUserId, reason }) {
  const { rows } = await pool.query(
    `
    UPDATE adaptive_memory_patterns
    SET status = 'reversed',
        reversed_at = NOW(),
        reversed_by = $1,
        reversal_reason = $2,
        updated_at = NOW()
    WHERE workspace_id = $3
      AND id = $4
      AND status = 'active'
    RETURNING *
    `,
    [actorUserId, reason || "Reversed by administrator", workspaceId, patternId]
  );
  return rows[0] || null;
}

async function loadExplanationSubject({ workspaceId, userId, role, actionId = null, subjectType = null, subjectId = null }) {
  const params = [workspaceId];
  const where = ["a.workspace_id = $1", "a.source = 'adaptive_runtime'"];
  if (actionId) {
    params.push(actionId);
    where.push(`a.id = $${params.length}`);
  } else if (subjectType === "task" && subjectId) {
    params.push(subjectId);
    where.push(`a.task_id = $${params.length}`);
  } else if (subjectType === "project" && subjectId) {
    params.push(subjectId);
    where.push(`a.project_id = $${params.length}`);
  }
  if (!["admin", "owner", "manager"].includes(role)) {
    params.push(userId);
    where.push(`(a.target_user_id = $${params.length} OR a.created_by = $${params.length})`);
  }
  const { rows } = await pool.query(
    `
    SELECT
      a.*,
      CASE WHEN e.id IS NULL THEN NULL ELSE to_jsonb(e) END AS evaluation
    FROM operations_ai_actions a
    LEFT JOIN LATERAL (
      SELECT *
      FROM adaptive_intelligence_evaluations ev
      WHERE ev.workspace_id = a.workspace_id
        AND ev.action_id = a.id
      ORDER BY ev.evaluated_at DESC
      LIMIT 1
    ) e ON TRUE
    WHERE ${where.join(" AND ")}
    ORDER BY a.created_at DESC
    LIMIT 1
    `,
    params
  );
  return rows[0] || null;
}

export async function getUniversalExplainability({ workspaceId, userId, role, actionId = null, subjectType = "recommendation", subjectId = null } = {}) {
  const action = await loadExplanationSubject({ workspaceId, userId, role, actionId, subjectType, subjectId });
  if (!action) return null;
  const evaluation = action.evaluation || null;
  const [memoryPatterns, similarEvaluations] = await Promise.all([
    listWorkspaceMemoryPatterns({ workspaceId }),
    pool.query(
      `
      SELECT recommendation_category, effectiveness_score, explainability, evaluated_at
      FROM adaptive_intelligence_evaluations
      WHERE workspace_id = $1
        AND recommendation_category = $2
        AND ($3::uuid IS NULL OR action_id != $3)
      ORDER BY evaluated_at DESC
      LIMIT 5
      `,
      [workspaceId, evaluation?.recommendation_category || businessCategoryForAction(action), action.id]
    ).then((result) => result.rows),
  ]);
  const explanationJson = buildUniversalExplanation({ action, evaluation, memoryPatterns, similarEvaluations });
  const explanation = JSON.parse(explanationJson);
  await pool.query(
    `
    INSERT INTO adaptive_universal_explanations (
      workspace_id, subject_type, subject_id, action_id, explanation, evidence
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
    `,
    [
      workspaceId,
      subjectType || "recommendation",
      subjectId || action.id,
      action.id,
      JSON.stringify(explanation),
      JSON.stringify(explanation.businessEvidence || []),
    ]
  ).catch((error) => {
    console.warn("[universal explainability] snapshot could not be recorded:", error.message);
  });
  return explanation;
}
