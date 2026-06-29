import pool from "../../db.js";
import { getUnifiedIntelligenceSnapshot } from "../engine/unifiedIntelligence.engine.js";
import { buildTrendAnalytics, getHistoricalSeries } from "./historicalAnalytics.service.js";
import { dashboardRangeMeta } from "./dashboardChartContract.service.js";
import {
  listProjectIntelligence,
  listTeamIntelligence,
  listUserIntelligence,
} from "../repositories/unifiedIntelligence.repository.js";
import { withLegacyIsolation } from "./cutoverIsolation.service.js";
import { advancedForecast } from "../forecast/forecast.engine.js";
import { adaptiveScore, clamp, roundScore } from "../engine/scorePrimitives.js";
import {
  getScoringGroupWeights,
  scoreObjectWithScoringConfig,
  scoreWithScoringConfig,
} from "../config/scoringConfig.model.js";
import { getWorkspaceScoringConfig } from "../repositories/scoringConfig.repository.js";

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function averageScore(users = []) {
  const scores = users.map((user) => Number(user.score)).filter(Number.isFinite);
  return scores.length
    ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100
    : null;
}

function summarizeUsers(users = []) {
  return {
    averageScore: averageScore(users),
    userCount: users.length,
    highPerformers: users.filter((user) => Number(user.score) >= 75).length,
    atRiskUsers: users.filter((user) => user.risk?.level === "High" || Number(user.score) < 48).length,
  };
}

function riskDistribution(users = [], style = "camel") {
  const counts = {
    low: users.filter((user) => user.risk?.level === "Low").length,
    medium: users.filter((user) => user.risk?.level === "Medium").length,
    high: users.filter((user) => user.risk?.level === "High").length,
  };
  if (style === "snake") {
    return {
      low_risk: counts.low,
      medium_risk: counts.medium,
      high_risk: counts.high,
    };
  }
  return {
    lowRisk: counts.low,
    mediumRisk: counts.medium,
    highRisk: counts.high,
  };
}

function scoreOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : null;
}

function avgScore(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function effectFromScore(score, { lowerIsBetter = false } = {}) {
  const value = Number(score);
  if (!Number.isFinite(value)) {
    return {
      effect: "unknown",
      label: "No closed evidence",
      tone: "neutral",
    };
  }
  const helpful = lowerIsBetter ? value <= 40 : value >= 76;
  const hurting = lowerIsBetter ? value >= 70 : value < 55;
  if (helpful) {
    return {
      effect: "positive_support",
      label: "Positive support",
      tone: "positive",
    };
  }
  if (hurting) {
    return {
      effect: "downward_pressure",
      label: "Downward pressure",
      tone: "negative",
    };
  }
  return {
    effect: "neutral_or_moderate",
    label: "Neutral / moderate",
    tone: "neutral",
  };
}

function normalizedPositiveWeights(rows = []) {
  const rawWeights = rows.map((row) => {
    const weight = Number(row.weight);
    return Number.isFinite(weight) && weight > 0 ? weight : 1;
  });
  const total = rawWeights.reduce((sum, weight) => sum + weight, 0) || rows.length || 1;
  return rawWeights.map((weight) => weight / total);
}

function adaptiveFormulaBreakdown(rows = [], options = {}) {
  const observed = rows
    .filter((row) => row && Number.isFinite(Number(row.score)))
    .map((row) => ({
      ...row,
      value: clamp(Number(row.score)),
    }));

  if (!observed.length) {
    const neutral = options.neutral ?? 60;
    return {
      mode: "no_observed_workspace_indexes",
      rawScoreBeforeRounding: round2(neutral),
      finalRoundedScore: roundScore(neutral),
      confidence: options.confidence == null ? null : round2(options.confidence),
      normalizedWeightsByKey: {},
      formulaComponents: [],
      weightedMean: null,
      weightedMedian: null,
      weightedHarmonic: null,
      balance: null,
    };
  }

  const rawWeights = observed.map((row) => {
    const weight = Number(row.weight);
    return Number.isFinite(weight) && weight > 0 ? weight : 1;
  });
  const firstWeight = rawWeights[0];
  const equalWeights = rawWeights.every((weight) => Math.abs(weight - firstWeight) < 0.000001);
  const normalizedWeights = normalizedPositiveWeights(observed);
  const values = observed.map((row) => row.value);
  const confidence = options.confidence == null ? 75 : clamp(options.confidence);

  let weightedMean;
  let weightedMedian;
  let weightedHarmonic;
  let mode;

  if (equalWeights) {
    mode = "adaptive_equal_weight_indexes";
    weightedMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sortedValues = [...values].sort((a, b) => a - b);
    weightedMedian = sortedValues[Math.floor(sortedValues.length / 2)];
    weightedHarmonic = values.length / values.reduce((sum, value) => sum + (1 / Math.max(8, value)), 0);
  } else {
    mode = "weighted_adaptive_indexes";
    const weighted = observed.map((row, index) => ({
      value: row.value,
      weight: normalizedWeights[index],
    }));
    weightedMean = weighted.reduce((sum, row) => sum + (row.value * row.weight), 0);
    const sorted = [...weighted].sort((a, b) => a.value - b.value);
    let cumulative = 0;
    weightedMedian = sorted[sorted.length - 1].value;
    for (const row of sorted) {
      cumulative += row.weight;
      if (cumulative >= 0.5) {
        weightedMedian = row.value;
        break;
      }
    }
    weightedHarmonic = 1 / weighted.reduce(
      (sum, row) => sum + (row.weight / Math.max(8, row.value)),
      0
    );
  }

  const low = values.reduce((min, value) => Math.min(min, value), values[0]);
  const high = values.reduce((max, value) => Math.max(max, value), values[0]);
  const balance = clamp(100 - ((high - low) * 0.35));
  const raw =
    (weightedMean * 0.32) +
    (weightedMedian * 0.30) +
    (weightedHarmonic * 0.22) +
    (balance * 0.10) +
    (confidence * 0.06);

  const componentDefinitions = [
    ["weightedMean", equalWeights ? "Mean" : "Weighted mean", weightedMean, 0.32],
    ["weightedMedian", equalWeights ? "Median" : "Weighted median", weightedMedian, 0.30],
    ["weightedHarmonic", equalWeights ? "Harmonic mean" : "Weighted harmonic mean", weightedHarmonic, 0.22],
    ["balance", "Balance / outlier dampener", balance, 0.10],
    ["confidence", "Evidence confidence", confidence, 0.06],
  ];

  return {
    mode,
    rawScoreBeforeRounding: round2(raw),
    finalRoundedScore: roundScore(raw),
    confidence: round2(confidence),
    normalizedWeightsRawByKey: Object.fromEntries(
      observed.map((row, index) => [row.key, normalizedWeights[index]])
    ),
    normalizedWeightsByKey: Object.fromEntries(
      observed.map((row, index) => [row.key, round4(normalizedWeights[index])])
    ),
    formulaComponents: componentDefinitions.map(([key, label, score, multiplier]) => ({
      key,
      label,
      score: round2(score),
      multiplier,
      contributionPoints: round2(score * multiplier),
    })),
    weightedMean: round2(weightedMean),
    weightedMedian: round2(weightedMedian),
    weightedHarmonic: round2(weightedHarmonic),
    balance: round2(balance),
  };
}

function computeScoreMath({ domainRows = [], attendanceScore = null, scoreModel = null } = {}) {
  const primaryRows = domainRows.filter((row) => row.key !== "professionalDiscipline" && row.score != null);
  const professional = domainRows.find((row) => row.key === "professionalDiscipline");
  const confidenceAverage = avgScore(domainRows.map((row) => row.confidence));
  const finalWeights = getScoringGroupWeights(scoreModel, "userFinalBalance");
  const coreScore = scoreWithScoringConfig(primaryRows.map((row) => ({ key: row.key, value: row.score })), scoreModel, "userCoreDomains", {
    confidence: confidenceAverage,
  });
  const professionalScore = Number(professional?.score || 0);
  const attendanceValue = Number(attendanceScore);
  const attendanceDrag = Number.isFinite(attendanceValue) && attendanceValue < 45 && coreScore > 70
    ? Math.min(8, (45 - attendanceValue) / 2)
    : 0;
  const attendanceLift = Number.isFinite(attendanceValue) && attendanceValue > 82 && coreScore < 62 ? 2 : 0;
  const coreWeight = finalWeights.core ?? 0.82;
  const professionalWeight = finalWeights.professionalDiscipline ?? 0.18;
  const coreContributionPoints = coreScore * coreWeight;
  const professionalContributionPoints = professionalScore * professionalWeight;
  const rawScore = coreContributionPoints + professionalContributionPoints - attendanceDrag + attendanceLift;

  return {
    coreScore,
    professionalScore,
    attendanceDrag,
    attendanceLift,
    coreContributionPoints,
    professionalContributionPoints,
    rawScore,
    finalScore: roundScore(rawScore),
    confidenceAverage,
    coreWeight,
    professionalWeight,
  };
}

function buildAttendanceContribution({ user = {}, domainRows = [] } = {}) {
  const attendanceScore = scoreOrNull(user.attendance?.score);
  const professional = domainRows.find((row) => row.key === "professionalDiscipline");
  const primaryRows = domainRows.filter((row) => row.key !== "professionalDiscipline" && row.score != null);
  const professionalMetrics = professional?.metrics || {};
  const scoreModel = user.scoreModel || user.analytics?.scoreModel || null;
  const finalWeights = getScoringGroupWeights(scoreModel, "userFinalBalance");
  const coreWeight = finalWeights.core ?? 0.82;
  const professionalWeight = finalWeights.professionalDiscipline ?? 0.18;

  if (attendanceScore == null || !professional || !primaryRows.length) {
    return {
      score: attendanceScore,
      parentDomain: "Professional Discipline",
      contributionType: "supporting_evidence",
      effectiveFinalLiftVsNoAttendanceSignal: null,
      effectiveFinalLiftVsNeutralAttendance: null,
      professionalWithoutAttendanceSignal: null,
      professionalWithNeutralAttendance: null,
      finalWithoutAttendanceSignal: null,
      finalWithNeutralAttendance: null,
      materiallyAffectsScore: false,
      summary: "Attendance is supporting evidence for Professional Discipline when closed attendance data is available.",
    };
  }

  const confidenceAverage = avgScore(domainRows.map((row) => row.confidence));
  const coreScore = scoreWithScoringConfig(primaryRows.map((row) => ({ key: row.key, value: row.score })), scoreModel, "userCoreDomains", {
    confidence: confidenceAverage,
  });
  const attendanceDrag = attendanceScore < 45 && coreScore > 70
    ? Math.min(8, (45 - attendanceScore) / 2)
    : 0;
  const attendanceLift = attendanceScore > 82 && coreScore < 62 ? 2 : 0;
  const finalWithAttendance = roundScore(
    (coreScore * coreWeight) + ((professional.score || 0) * professionalWeight) - attendanceDrag + attendanceLift
  );
  const professionalWithoutAttendanceSignal = adaptiveScore([
    { value: professionalMetrics.reviewCompletion },
    { value: professionalMetrics.updateHygiene },
    { value: professionalMetrics.workflowScore },
  ], { confidence: professional?.confidence ?? 75 });
  const professionalWithNeutralAttendance = adaptiveScore([
    { value: 60 },
    { value: professionalMetrics.reviewCompletion },
    { value: professionalMetrics.updateHygiene },
    { value: professionalMetrics.workflowScore },
  ], { confidence: professional?.confidence ?? 75 });
  const finalWithoutAttendanceSignal = roundScore((coreScore * coreWeight) + (professionalWithoutAttendanceSignal * professionalWeight));
  const finalWithNeutralAttendance = roundScore((coreScore * coreWeight) + (professionalWithNeutralAttendance * professionalWeight));
  const liftVsNoSignal = finalWithAttendance - finalWithoutAttendanceSignal;
  const liftVsNeutral = finalWithAttendance - finalWithNeutralAttendance;

  return {
    score: attendanceScore,
    parentDomain: "Professional Discipline",
    contributionType: "supporting_evidence",
    effectiveFinalLiftVsNoAttendanceSignal: liftVsNoSignal,
    effectiveFinalLiftVsNeutralAttendance: liftVsNeutral,
    professionalWithoutAttendanceSignal,
    professionalWithNeutralAttendance,
    finalWithoutAttendanceSignal,
    finalWithNeutralAttendance,
    directLiftOrDrag: scoreOrNull(attendanceLift - attendanceDrag),
    materiallyAffectsScore: Math.abs(liftVsNoSignal) > 0,
    summary: Math.abs(liftVsNoSignal) > 0
      ? `Attendance feeds Professional Discipline and changes the final score by about ${liftVsNoSignal > 0 ? "+" : ""}${liftVsNoSignal} point(s) versus removing attendance evidence.`
      : "Attendance feeds Professional Discipline; in this window it does not create a separate final-score lift or drag.",
  };
}

function buildScoreCalculation({ user = {}, domainRows = [], attendanceContribution = {} } = {}) {
  const attendanceScore = scoreOrNull(user.attendance?.score);
  const scoreModel = user.scoreModel || user.analytics?.scoreModel || null;
  const userCoreWeights = getScoringGroupWeights(scoreModel, "userCoreDomains");
  const calculation = computeScoreMath({ domainRows, attendanceScore, scoreModel });
  const professional = domainRows.find((row) => row.key === "professionalDiscipline") || {};
  const professionalMetrics = professional.metrics || {};
  const neutralDomainScore = 60;

  const domainContributions = domainRows
    .filter((row) => row.score != null)
    .map((row) => {
      const neutralRows = domainRows.map((candidate) =>
        candidate.key === row.key ? { ...candidate, score: neutralDomainScore } : candidate
      );
      const neutralCalculation = computeScoreMath({ domainRows: neutralRows, attendanceScore, scoreModel });
      const impact = calculation.finalScore - neutralCalculation.finalScore;
      const isProfessional = row.key === "professionalDiscipline";
      const coreDomainWeight = userCoreWeights[row.key] ?? null;
      return {
        key: row.key,
        label: row.label,
        score: row.score,
        block: isProfessional ? "professional_discipline_block" : "core_score_block",
        multiplier: isProfessional ? calculation.professionalWeight : calculation.coreWeight,
        domainWeight: isProfessional ? calculation.professionalWeight : coreDomainWeight,
        effectiveWeight: isProfessional ? calculation.professionalWeight : round2((calculation.coreWeight || 0) * (coreDomainWeight || 0)),
        contributionType: isProfessional ? "direct_weighted_contribution" : "nonlinear_core_marginal_effect",
        weightedContributionPoints: isProfessional ? round2(row.score * calculation.professionalWeight) : null,
        finalScoreImpactVsNeutral: impact,
        neutralCounterfactualScore: neutralCalculation.finalScore,
        effect: effectFromScore(row.score),
        explanation: isProfessional
          ? `Professional Discipline contributes through the configured ${Math.round((calculation.professionalWeight || 0) * 100)}% discipline block and is formed from attendance, reviews, hygiene, and workflow evidence.`
          : "This domain participates in the nonlinear core block. Impact is shown as the final-score change versus a neutral 60/100 domain value.",
      };
    });

  const professionalFormationInputs = [
    {
      key: "attendanceEvidence",
      label: "Attendance Evidence",
      value: scoreOrNull(professionalMetrics.attendanceScore ?? attendanceScore),
      feedsDomains: ["Professional Discipline"],
      effect: effectFromScore(professionalMetrics.attendanceScore ?? attendanceScore),
      note: "Closed attendance evidence feeds Professional Discipline.",
    },
    {
      key: "reviewCompletion",
      label: "Review Completion",
      value: scoreOrNull(professionalMetrics.reviewCompletion),
      feedsDomains: ["Professional Discipline", "Collaboration Health"],
      effect: effectFromScore(professionalMetrics.reviewCompletion),
      note: "Review completion is used in Professional Discipline and Collaboration Health.",
    },
    {
      key: "updateHygiene",
      label: "Update Hygiene",
      value: scoreOrNull(professionalMetrics.updateHygiene),
      feedsDomains: ["Professional Discipline"],
      effect: effectFromScore(professionalMetrics.updateHygiene),
      note: "Task activity and update visibility feed Professional Discipline.",
    },
    {
      key: "workflowCompliance",
      label: "Workflow Compliance",
      value: scoreOrNull(professionalMetrics.workflowScore),
      feedsDomains: ["Professional Discipline"],
      effect: effectFromScore(professionalMetrics.workflowScore),
      note: "Workflow actions such as status or priority changes feed Professional Discipline.",
    },
  ].filter((item) => item.value != null);

  return {
    source: "enterprise_intelligence",
    scoreAuthority: "user_intelligence.score",
    formulaLabel: "Core domains + Professional Discipline + bounded attendance lift/drag",
    formulaReadable:
      `final score = round((core score x ${round2(calculation.coreWeight)}) + (professional discipline x ${round2(calculation.professionalWeight)}) - attendance drag + attendance lift)`,
    finalScore: scoreOrNull(user.score),
    reconstructedFinalScore: calculation.finalScore,
    rawScoreBeforeRounding: round2(calculation.rawScore),
    coreScore: calculation.coreScore,
    coreMultiplier: round2(calculation.coreWeight),
    coreContributionPoints: round2(calculation.coreContributionPoints),
    professionalDisciplineScore: calculation.professionalScore,
    professionalDisciplineMultiplier: round2(calculation.professionalWeight),
    professionalDisciplineContributionPoints: round2(calculation.professionalContributionPoints),
    attendanceDrag: round2(calculation.attendanceDrag),
    attendanceLift: round2(calculation.attendanceLift),
    directAttendanceAdjustment: round2(calculation.attendanceLift - calculation.attendanceDrag),
    confidenceAverage: round2(calculation.confidenceAverage),
    confidenceNote: "Confidence participates inside the deterministic enterprise intelligence normalization; the UI renders this backend-owned result.",
    scoreModel,
    domainContributions,
    attendanceEffect: {
      score: attendanceScore,
      feedsDomain: "Professional Discipline",
      professionalWithAttendance: professional.score ?? null,
      professionalWithoutAttendanceSignal: attendanceContribution.professionalWithoutAttendanceSignal ?? null,
      professionalWithNeutralAttendance: attendanceContribution.professionalWithNeutralAttendance ?? null,
      finalWithoutAttendanceSignal: attendanceContribution.finalWithoutAttendanceSignal ?? null,
      finalWithNeutralAttendance: attendanceContribution.finalWithNeutralAttendance ?? null,
      effectiveFinalLiftVsNoAttendanceSignal: attendanceContribution.effectiveFinalLiftVsNoAttendanceSignal ?? null,
      effectiveFinalLiftVsNeutralAttendance: attendanceContribution.effectiveFinalLiftVsNeutralAttendance ?? null,
      materiallyAffectsScore: attendanceContribution.materiallyAffectsScore === true,
      summary: attendanceContribution.summary,
    },
    professionalDisciplineFormation: {
      score: professional.score ?? null,
      source: "user_intelligence.dimensions.professionalDiscipline",
      inputs: professionalFormationInputs,
      summary: "Professional Discipline is formed from attendance, review completion, update hygiene, and workflow compliance evidence.",
    },
  };
}

function evidenceInput({ key, label, score, parentDomain, feedsDomains = null, source, note, materiality = "supporting" }) {
  const value = scoreOrNull(score);
  const effect = effectFromScore(value);
  return {
    key,
    label,
    score: value,
    parentDomain,
    feedsDomains: feedsDomains || (parentDomain ? [parentDomain] : []),
    source,
    materiality,
    effect: effect.effect,
    effectLabel: effect.label,
    effectTone: effect.tone,
    note,
  };
}

function diagnosticDriver({
  key,
  label,
  value,
  parentDomain,
  feedsDomains = null,
  direction = "higher_is_better",
  note,
  impactType = "direct_domain_input",
  scoreAffecting = true,
}) {
  const normalizedValue = scoreOrNull(value);
  const effect = effectFromScore(normalizedValue, { lowerIsBetter: direction === "lower_is_better" });
  return {
    key,
    label,
    value: normalizedValue,
    parentDomain,
    feedsDomains: feedsDomains || (parentDomain ? [parentDomain] : []),
    direction,
    impactType,
    scoreAffecting,
    materiality: scoreAffecting ? "domain_shaping" : "context_only",
    effect: effect.effect,
    effectLabel: effect.label,
    effectTone: effect.tone,
    contributionPath: scoreAffecting
      ? `${label} -> ${parentDomain} -> final score`
      : `${label} supports interpretation of ${parentDomain}; it is not directly weighted into the final score.`,
    note,
  };
}

function buildUserScoreExplanation(user = {}) {
  const dimensions = user.dimensions || {};
  const attendance = user.attendance || {};
  const domainRows = [
    {
      key: "executionReliability",
      label: "Execution Reliability",
      score: scoreOrNull(dimensions.executionReliability?.score),
      source: "user_intelligence.dimensions.executionReliability.score",
      role: "core_execution_domain",
      note: "Commitment completion, due-date discipline, carry-over behavior, ownership, and blocker responsiveness.",
      metrics: dimensions.executionReliability?.metrics || {},
      strengths: dimensions.executionReliability?.strengths || [],
      drivers: dimensions.executionReliability?.drivers || [],
      concerns: dimensions.executionReliability?.concerns || [],
      confidence: scoreOrNull(dimensions.executionReliability?.confidence),
    },
    {
      key: "deliveryEffectiveness",
      label: "Delivery Effectiveness",
      score: scoreOrNull(dimensions.deliveryEffectiveness?.score),
      source: "user_intelligence.dimensions.deliveryEffectiveness.score",
      role: "core_delivery_domain",
      note: "Throughput, velocity, estimation quality, completion quality, and output consistency.",
      metrics: dimensions.deliveryEffectiveness?.metrics || {},
      strengths: dimensions.deliveryEffectiveness?.strengths || [],
      drivers: dimensions.deliveryEffectiveness?.drivers || [],
      concerns: dimensions.deliveryEffectiveness?.concerns || [],
      confidence: scoreOrNull(dimensions.deliveryEffectiveness?.confidence),
    },
    {
      key: "collaborationHealth",
      label: "Collaboration Health",
      score: scoreOrNull(dimensions.collaborationHealth?.score),
      source: "user_intelligence.dimensions.collaborationHealth.score",
      role: "core_collaboration_domain",
      note: "Participation, reviews, comments, stakeholder engagement, and cross-team signals.",
      metrics: dimensions.collaborationHealth?.metrics || {},
      strengths: dimensions.collaborationHealth?.strengths || [],
      drivers: dimensions.collaborationHealth?.drivers || [],
      concerns: dimensions.collaborationHealth?.concerns || [],
      confidence: scoreOrNull(dimensions.collaborationHealth?.confidence),
    },
    {
      key: "workSustainability",
      label: "Work Sustainability",
      score: scoreOrNull(dimensions.workSustainability?.score),
      source: "user_intelligence.dimensions.workSustainability.score",
      role: "core_sustainability_domain",
      note: "Workload balance, carry-over health, focus fragmentation, overtime risk, and productivity under load.",
      metrics: dimensions.workSustainability?.metrics || {},
      strengths: dimensions.workSustainability?.strengths || [],
      drivers: dimensions.workSustainability?.drivers || [],
      concerns: dimensions.workSustainability?.concerns || [],
      confidence: scoreOrNull(dimensions.workSustainability?.confidence),
    },
    {
      key: "professionalDiscipline",
      label: "Professional Discipline",
      score: scoreOrNull(dimensions.professionalDiscipline?.score),
      source: "user_intelligence.dimensions.professionalDiscipline.score",
      role: "discipline_balancing_domain",
      note: "Attendance, review completion, update hygiene, and workflow compliance.",
      metrics: dimensions.professionalDiscipline?.metrics || {},
      strengths: dimensions.professionalDiscipline?.strengths || [],
      drivers: dimensions.professionalDiscipline?.drivers || [],
      concerns: dimensions.professionalDiscipline?.concerns || [],
      confidence: scoreOrNull(dimensions.professionalDiscipline?.confidence),
    },
  ];

  const lowestDomains = [...domainRows]
    .filter((row) => row.score != null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2);
  const strongestDomains = [...domainRows]
    .filter((row) => row.score != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const attendanceScore = scoreOrNull(attendance.score);
  const deliveryScore = scoreOrNull(dimensions.deliveryEffectiveness?.score);
  const attendanceContribution = buildAttendanceContribution({ user, domainRows });
  const professionalMetrics = dimensions.professionalDiscipline?.metrics || {};
  const executionMetrics = dimensions.executionReliability?.metrics || {};
  const deliveryMetrics = dimensions.deliveryEffectiveness?.metrics || {};
  const collaborationMetrics = dimensions.collaborationHealth?.metrics || {};
  const sustainabilityMetrics = dimensions.workSustainability?.metrics || {};
  const evidenceInputs = [
    evidenceInput({
      key: "attendanceEvidence",
      label: "Attendance Evidence",
      score: attendanceScore,
      parentDomain: "Professional Discipline",
      feedsDomains: ["Professional Discipline"],
      source: "user_intelligence.attendance.score",
      materiality: attendanceContribution.materiallyAffectsScore ? "material" : "supporting",
      note: attendanceContribution.summary,
    }),
    evidenceInput({
      key: "reviewCompletion",
      label: "Review Completion",
      score: professionalMetrics.reviewCompletion,
      parentDomain: "Professional Discipline / Collaboration Health",
      feedsDomains: ["Professional Discipline", "Collaboration Health"],
      source: "user_intelligence.dimensions.professionalDiscipline.metrics.reviewCompletion",
      note: "Review completion supports Professional Discipline and also participates in Collaboration Health.",
    }),
    evidenceInput({
      key: "updateHygiene",
      label: "Update Hygiene",
      score: professionalMetrics.updateHygiene,
      parentDomain: "Professional Discipline",
      feedsDomains: ["Professional Discipline"],
      source: "user_intelligence.dimensions.professionalDiscipline.metrics.updateHygiene",
      note: "Visible activity and comments help prove work is being kept current.",
    }),
    evidenceInput({
      key: "workflowCompliance",
      label: "Workflow Compliance",
      score: professionalMetrics.workflowScore,
      parentDomain: "Professional Discipline",
      feedsDomains: ["Professional Discipline"],
      source: "user_intelligence.dimensions.professionalDiscipline.metrics.workflowScore",
      note: "Workflow actions such as status and priority updates support operating discipline.",
    }),
    evidenceInput({
      key: "deliveryEvidence",
      label: "Delivery Evidence",
      score: deliveryScore,
      parentDomain: "Delivery Effectiveness",
      feedsDomains: ["Delivery Effectiveness"],
      source: "user_intelligence.dimensions.deliveryEffectiveness.score",
      note: "Delivery Effectiveness is a final score domain; this evidence row explains the delivery signal behind it.",
    }),
  ].filter((item) => item.score != null);

  const diagnosticDrivers = [
    diagnosticDriver({
      key: "commitmentCompletion",
      label: "Commitment Completion",
      value: executionMetrics.commitmentCompletion,
      parentDomain: "Execution Reliability",
      feedsDomains: ["Execution Reliability"],
      note: "Completed assigned work in the active evidence window.",
    }),
    diagnosticDriver({
      key: "timeliness",
      label: "Timeliness",
      value: executionMetrics.dueDateDiscipline,
      parentDomain: "Execution Reliability",
      feedsDomains: ["Execution Reliability"],
      note: "On-time delivery for due-date tracked work.",
    }),
    diagnosticDriver({
      key: "blockerResponsiveness",
      label: "Blocker Responsiveness",
      value: executionMetrics.blockerResponsiveness,
      parentDomain: "Execution Reliability",
      feedsDomains: ["Execution Reliability"],
      note: "Responsiveness to blocked or blocking work.",
    }),
    diagnosticDriver({
      key: "taskVelocity",
      label: "Task Velocity",
      value: deliveryMetrics.velocity,
      parentDomain: "Delivery Effectiveness",
      feedsDomains: ["Delivery Effectiveness"],
      note: "Completion pace within the delivery domain.",
    }),
    diagnosticDriver({
      key: "estimationQuality",
      label: "Estimation Quality",
      value: deliveryMetrics.estimationQuality,
      parentDomain: "Delivery Effectiveness",
      feedsDomains: ["Delivery Effectiveness"],
      note: "Alignment between estimated and logged effort.",
    }),
    diagnosticDriver({
      key: "collaborationParticipation",
      label: "Collaboration Participation",
      value: collaborationMetrics.participation,
      parentDomain: "Collaboration Health",
      feedsDomains: ["Collaboration Health"],
      note: "Visible collaboration through comments, watched work, and related activity.",
    }),
    diagnosticDriver({
      key: "workloadBalance",
      label: "Workload Balance",
      value: sustainabilityMetrics.workloadBalance,
      parentDomain: "Work Sustainability",
      feedsDomains: ["Work Sustainability"],
      note: "Whether open work stays within a manageable range.",
    }),
    diagnosticDriver({
      key: "workloadStress",
      label: "Workload Stress",
      value: 100 - Number(dimensions.workSustainability?.score ?? 0),
      parentDomain: "Work Sustainability",
      feedsDomains: ["Work Sustainability"],
      direction: "lower_is_better",
      impactType: "diagnostic_context",
      scoreAffecting: false,
      note: "Diagnostic inverse of sustainability posture; lower is healthier.",
    }),
  ].filter((item) => item.value != null);
  const scoreCalculation = buildScoreCalculation({ user, domainRows, attendanceContribution });
  const tracedDiagnosticDrivers = attachDiagnosticDriverTrace(diagnosticDrivers, scoreCalculation);
  const time = {
    computedAt: user.computedAt,
    coverageStart: user.coverageStart,
    coverageEnd: user.coverageEnd,
    attendanceClosedThroughDate: user.attendanceClosedThroughDate,
    snapshotDate: user.snapshotDate,
    intelligenceMode: user.intelligenceMode,
  };
  const scoreTrace = canonicalScoreTrace({
    scoreAuthority: "user_intelligence.score",
    formulaReadable: scoreCalculation.formulaReadable,
    finalScore: user.score,
    rawScoreBeforeRounding: scoreCalculation.rawScoreBeforeRounding,
    finalRoundedScore: scoreCalculation.finalScore,
    confidence: user.confidence,
    rawEvidence: [
      ...(user.drivers || []).map((driver) => ({ label: driver })),
      ...evidenceInputs.map((item) => ({
        key: item.key,
        label: item.label,
        score: item.score,
        source: item.source,
        feedsDomains: item.feedsDomains,
        materiality: item.materiality,
      })),
    ],
    normalizedEvidence: domainRows,
    weightedContributions: scoreCalculation.domainContributions,
    aggregation: {
      coreScore: scoreCalculation.coreScore,
      coreMultiplier: scoreCalculation.coreMultiplier,
      coreContributionPoints: scoreCalculation.coreContributionPoints,
      professionalDisciplineScore: scoreCalculation.professionalDisciplineScore,
      professionalDisciplineMultiplier: scoreCalculation.professionalDisciplineMultiplier,
      professionalDisciplineContributionPoints: scoreCalculation.professionalDisciplineContributionPoints,
      attendanceDrag: scoreCalculation.attendanceDrag,
      attendanceLift: scoreCalculation.attendanceLift,
      directAttendanceAdjustment: scoreCalculation.directAttendanceAdjustment,
    },
    time,
  });
  const scoreTooltip = canonicalScoreTooltip({
    scoreAuthority: "user_intelligence.score",
    formulaReadable: scoreCalculation.formulaReadable,
    scoreTrace,
    positiveDrivers: [...(user.strengths || []), ...strongestDomains],
    negativeDrivers: [...(user.concerns || []), ...lowestDomains],
    confidence: user.confidence,
    time,
  });

  return {
    source: "enterprise_intelligence",
    scoreAuthority: "user_intelligence.score",
    score: scoreOrNull(user.score),
    risk: user.risk || {},
    confidence: scoreOrNull(user.confidence),
    finalScoreIsNotAverageOfEvidenceBars: true,
    summary: lowestDomains.length
      ? `Overall score is the canonical user intelligence result, not an average of the visible evidence bars. The strongest downward pressure is currently ${lowestDomains.map((row) => `${row.label} (${row.score}/100)`).join(" and ")}.`
      : "Overall score is the canonical user intelligence result, not an average of the visible evidence bars.",
    scoreNarrative: {
      title: "Final Performance Score",
      summary: lowestDomains.length
        ? `The final score is ${scoreOrNull(user.score)}/100 from user_intelligence.score. It is being pulled down most by ${lowestDomains.map((row) => `${row.label} (${row.score}/100)`).join(" and ")}.`
        : `The final score is ${scoreOrNull(user.score)}/100 from user_intelligence.score.`,
      liftSummary: strongestDomains.length
        ? `Strongest supporting domains: ${strongestDomains.map((row) => `${row.label} (${row.score}/100)`).join(" and ")}.`
        : null,
      scoreAuthority: "user_intelligence.score",
      confidence: scoreOrNull(user.confidence),
      risk: user.risk || {},
      finalScoreIsNotAverageOfEvidenceBars: true,
    },
    scoreComposition: domainRows,
    scoreCalculation,
    scoreTrace,
    scoreTooltip,
    evidenceInputs,
    diagnosticDrivers: tracedDiagnosticDrivers,
    attendanceContribution,
    evidenceBars: [
      {
        key: "attendanceScore",
        label: "Attendance Evidence",
        score: attendanceScore,
        source: "user_intelligence.attendance.score",
        role: "feeds_professional_discipline",
        note: "Attendance contributes through Professional Discipline and attendance lift/drag rules, but it does not override execution and delivery evidence.",
      },
      {
        key: "deliveryEffectiveness",
        label: "Delivery Effectiveness",
        score: deliveryScore,
        source: "user_intelligence.dimensions.deliveryEffectiveness.score",
        role: "core_delivery_domain",
        note: "This is the delivery domain score, not the final productivity/performance score.",
      },
    ],
    domainRows,
    time,
  };
}

const WORKSPACE_INDEX_EXPLANATIONS = {
  workspaceHealthIndex: "Composite workspace health from user, project, team, and execution reality evidence.",
  productivityIndex: "Delivery effectiveness, velocity health, and high-performer distribution.",
  strategicRiskIndex: "Inverse risk posture from at-risk employees, critical projects, and score drag.",
  deliveryConfidenceIndex: "Project completion confidence and team delivery reliability.",
  organizationalAlignmentIndex: "Team predictability, collaboration, and project alignment signals.",
  executionRealityIndex: "Tracked internal and integration work completion evidence.",
  attendanceReadinessIndex: "Closed attendance readiness and Professional Discipline across users.",
  capacitySustainabilityIndex: "Work sustainability and team workload balance signals.",
};

function workspaceIndexLabel(key) {
  return String(key || "")
    .replace(/Index$/, "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (char) => char.toUpperCase())
    .trim();
}

function canonicalScoreTrace({
  scoreAuthority,
  formulaReadable,
  finalScore,
  rawScoreBeforeRounding = null,
  finalRoundedScore = null,
  confidence = null,
  rawEvidence = [],
  normalizedEvidence = [],
  weightedContributions = [],
  aggregation = {},
  time = {},
} = {}) {
  return {
    source: "enterprise_intelligence",
    scoreAuthority,
    formula: formulaReadable,
    rawEvidence,
    normalizedEvidence,
    domainScores: normalizedEvidence.map((item) => ({
      key: item.key,
      label: item.label,
      domainScore: item.score,
      source: item.source || null,
    })),
    weightedContributions,
    aggregation,
    confidence: scoreOrNull(confidence),
    rawScoreBeforeRounding,
    finalRoundedScore: finalRoundedScore ?? scoreOrNull(finalScore),
    finalScore: scoreOrNull(finalScore),
    time,
  };
}

function canonicalScoreTooltip({
  scoreAuthority,
  formulaReadable,
  scoreTrace,
  positiveDrivers = [],
  negativeDrivers = [],
  confidence = null,
  time = {},
} = {}) {
  return {
    source: "enterprise_intelligence",
    authority: scoreAuthority,
    formula: formulaReadable,
    normalizedInputs: scoreTrace?.normalizedEvidence || [],
    weightedContribution: scoreTrace?.weightedContributions || [],
    positiveDrivers: compactDriverLabels(positiveDrivers),
    negativeDrivers: compactDriverLabels(negativeDrivers),
    confidence: scoreOrNull(confidence),
    lastRecalculated: time.computedAt || null,
    coveragePeriod: {
      coverageStart: time.coverageStart || null,
      coverageEnd: time.coverageEnd || null,
      attendanceClosedThroughDate: time.attendanceClosedThroughDate || null,
      snapshotDate: time.snapshotDate || null,
      intelligenceMode: time.intelligenceMode || null,
    },
    scoreTrace,
  };
}

function compactDriverLabels(items = [], limit = 5) {
  const labels = [];
  const seen = new Set();
  for (const item of items || []) {
    const label = typeof item === "string"
      ? item
      : item?.label || item?.note || item?.summary || item?.key || "";
    const normalized = String(label || "").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    labels.push(normalized);
    if (labels.length >= limit) break;
  }
  return labels;
}

function attachDiagnosticDriverTrace(drivers = [], scoreCalculation = {}) {
  const domains = Array.isArray(scoreCalculation.domainContributions)
    ? scoreCalculation.domainContributions
    : [];
  return drivers.map((driver) => {
    const domain = domains.find((item) =>
      item.key === driver.parentDomain ||
      item.label === driver.parentDomain ||
      (Array.isArray(driver.feedsDomains) && driver.feedsDomains.includes(item.label))
    );
    const finalContribution = driver.scoreAffecting === false
      ? null
      : domain?.finalScoreImpactVsNeutral ?? null;
    return {
      ...driver,
      feeds: driver.label,
      domain: driver.parentDomain,
      finalContribution,
      finalContributionLabel: finalContribution == null
        ? "Context only"
        : `${finalContribution >= 0 ? "+" : ""}${finalContribution} final score movement vs neutral ${domain?.label || "domain"}`,
      tracePrecision: finalContribution == null ? "context_only" : "domain_level_marginal_effect",
      trace: {
        feeds: driver.label,
        domain: driver.parentDomain,
        finalContribution,
        contributionPath: driver.contributionPath,
        scoreAffecting: driver.scoreAffecting !== false,
        sourceDomainContribution: domain || null,
      },
    };
  });
}

function buildIndexScoreExplanation(entity = {}, { scoreAuthority, groupKey, fallbackLabel } = {}) {
  const scoreModel = entity.scoreModel || entity.analytics?.scoreModel || null;
  const weights = getScoringGroupWeights(scoreModel, groupKey);
  const indexes = entity.indexes || {};
  const keys = Object.keys(weights).length ? Object.keys(weights) : Object.keys(indexes);
  const rows = keys.map((key) => {
    const score = scoreOrNull(indexes[key]);
    const weight = Number(weights[key]);
    return {
      key,
      label: scoreModel?.groups?.[groupKey]?.slots?.[key]?.label || workspaceIndexLabel(key),
      score,
      configuredWeight: Number.isFinite(weight) ? round4(weight) : null,
      source: `${scoreAuthority.replace(".score", "")}.indexes.${key}`,
      effect: effectFromScore(score),
    };
  }).filter((row) => row.score != null);
  const normalizedWeights = normalizedPositiveWeights(rows.map((row) => ({
    ...row,
    weight: row.configuredWeight,
  })));
  const indexValues = Object.fromEntries(rows.map((row) => [row.key, row.score]));
  const reconstructedFinalScore = rows.length
    ? scoreObjectWithScoringConfig(indexValues, scoreModel, groupKey, {
      confidence: entity.confidence ?? 75,
    })
    : scoreOrNull(entity.score);
  const weightedContributions = rows.map((row, index) => ({
    key: row.key,
    label: row.label,
    score: row.score,
    configuredWeight: row.configuredWeight,
    normalizedWeight: round4(normalizedWeights[index]),
    weightedContributionPoints: round2(row.score * normalizedWeights[index]),
    source: row.source,
    effect: row.effect,
  }));
  const upward = [...weightedContributions].sort((a, b) => b.score - a.score).slice(0, 2);
  const downward = [...weightedContributions].sort((a, b) => a.score - b.score).slice(0, 2);
  const time = entity.time || {
    computedAt: entity.computedAt,
    coverageStart: entity.coverageStart,
    coverageEnd: entity.coverageEnd,
    attendanceClosedThroughDate: entity.attendanceClosedThroughDate,
    snapshotDate: entity.snapshotDate,
    intelligenceMode: entity.intelligenceMode,
  };
  const formulaReadable = `${fallbackLabel || "Canonical score"} is generated by the enterprise evaluator from persisted repository indexes, configured score model weights, confidence, and bounded normalization.`;
  const scoreTrace = canonicalScoreTrace({
    scoreAuthority,
    formulaReadable,
    finalScore: entity.score,
    rawScoreBeforeRounding: reconstructedFinalScore,
    finalRoundedScore: scoreOrNull(entity.score),
    confidence: entity.confidence,
    rawEvidence: (entity.drivers || []).map((driver) => ({ label: driver })),
    normalizedEvidence: rows,
    weightedContributions,
    aggregation: {
      groupKey,
      reconstructedFinalScore,
      finalScoreIsRepositoryValue: true,
    },
    time,
  });
  const scoreTooltip = canonicalScoreTooltip({
    scoreAuthority,
    formulaReadable,
    scoreTrace,
    positiveDrivers: [...(entity.strengths || []), ...upward],
    negativeDrivers: [...(entity.concerns || []), ...downward],
    confidence: entity.confidence,
    time,
  });
  return {
    source: "enterprise_intelligence",
    scoreAuthority,
    formulaReadable,
    finalScore: scoreOrNull(entity.score),
    reconstructedFinalScore,
    confidence: scoreOrNull(entity.confidence),
    scoreModel,
    domainContributions: weightedContributions,
    upwardPressures: upward,
    downwardPressures: downward,
    strengths: entity.strengths || [],
    concerns: entity.concerns || [],
    drivers: entity.drivers || [],
    scoreTrace,
    scoreTooltip,
    time,
  };
}

function buildWorkspaceScoreExplanation(workspace = {}, { scoringConfig = null } = {}) {
  const indexes = workspace.indexes || {};
  const scoreModel = workspace.scoreModel || workspace.analytics?.scoreModel || null;
  const weights = getScoringGroupWeights(scoreModel, "workspaceIndexes");
  const userScoreBalanceWeights = getScoringGroupWeights(scoringConfig || {}, "userFinalBalance");
  const indexRows = Object.keys(weights).map((key) => ({
    key,
    label: scoreModel?.groups?.workspaceIndexes?.slots?.[key]?.label || workspaceIndexLabel(key),
    score: scoreOrNull(indexes[key]),
    weight: round4(weights[key]),
    source: `workspace_intelligence.indexes.${key}`,
    note: WORKSPACE_INDEX_EXPLANATIONS[key] || "Workspace intelligence index.",
    effect: effectFromScore(indexes[key]),
  })).filter((row) => row.score != null);

  const indexValues = Object.fromEntries(indexRows.map((row) => [row.key, row.score]));
  const reconstructedFinalScore = scoreObjectWithScoringConfig(indexValues, scoreModel, "workspaceIndexes", {
    confidence: workspace.confidence ?? 75,
  });
  const adaptiveBreakdown = adaptiveFormulaBreakdown(indexRows, {
    confidence: workspace.confidence ?? 75,
  });
  const domainContributions = indexRows.map((row) => {
    const normalizedWeight = adaptiveBreakdown.normalizedWeightsRawByKey?.[row.key] ?? row.weight ?? 0;
    const neutralValues = {
      ...indexValues,
      [row.key]: 60,
    };
    const neutralScore = scoreObjectWithScoringConfig(neutralValues, scoreModel, "workspaceIndexes", {
      confidence: workspace.confidence ?? 75,
    });
    return {
      ...row,
      configuredWeight: row.weight,
      normalizedWeight: round4(normalizedWeight),
      weightedContributionPoints: round2(row.score * normalizedWeight),
      weightedMeanContributionPoints: round2(row.score * normalizedWeight),
      finalScoreImpactVsNeutral: reconstructedFinalScore - neutralScore,
      neutralCounterfactualScore: neutralScore,
      contributionType: "weighted_workspace_index",
    };
  });
  const downward = [...domainContributions].sort((a, b) => a.score - b.score).slice(0, 2);
  const upward = [...domainContributions].sort((a, b) => b.score - a.score).slice(0, 2);
  const attendanceRow = domainContributions.find((row) => row.key === "attendanceReadinessIndex");
  const capacityRow = domainContributions.find((row) => row.key === "capacitySustainabilityIndex");
  const scoreCalculation = {
    source: "enterprise_intelligence",
    scoreAuthority: "workspace_intelligence.score",
    formulaLabel: "Adaptive weighted workspace intelligence indexes",
    formulaReadable:
      "workspace score = weighted/adaptive blend of workspace index scores: weighted mean 32%, median 30%, harmonic mean 22%, balance 10%, evidence confidence 6%",
    finalScore: scoreOrNull(workspace.score),
    reconstructedFinalScore,
    rawScoreBeforeRounding: adaptiveBreakdown.rawScoreBeforeRounding,
    finalRoundedScore: adaptiveBreakdown.finalRoundedScore,
    confidence: scoreOrNull(workspace.confidence),
    mode: adaptiveBreakdown.mode,
    scoreModel,
    domainContributions,
    formulaComponents: adaptiveBreakdown.formulaComponents,
    weightedMean: adaptiveBreakdown.weightedMean,
    weightedMedian: adaptiveBreakdown.weightedMedian,
    weightedHarmonic: adaptiveBreakdown.weightedHarmonic,
    balance: adaptiveBreakdown.balance,
    attendanceReadinessContribution: attendanceRow ? {
      key: attendanceRow.key,
      label: attendanceRow.label,
      score: attendanceRow.score,
      configuredWeight: attendanceRow.configuredWeight,
      normalizedWeight: attendanceRow.normalizedWeight,
      weightedContributionPoints: attendanceRow.weightedContributionPoints,
      finalScoreImpactVsNeutral: attendanceRow.finalScoreImpactVsNeutral,
      contributionPath: "direct_workspace_index",
      directOrIndirect: "direct",
      source: attendanceRow.source,
      note: "Closed attendance readiness and Professional Discipline rollups feed this workspace index directly.",
    } : null,
    workforceSustainabilityContribution: capacityRow ? {
      key: capacityRow.key,
      label: capacityRow.label,
      score: capacityRow.score,
      configuredWeight: capacityRow.configuredWeight,
      normalizedWeight: capacityRow.normalizedWeight,
      weightedContributionPoints: capacityRow.weightedContributionPoints,
      finalScoreImpactVsNeutral: capacityRow.finalScoreImpactVsNeutral,
      contributionPath: "direct_workspace_index",
      directOrIndirect: "direct",
      source: capacityRow.source,
    } : null,
    userScoreBalancePropagation: {
      intended: true,
      mode: "indirect_user_intelligence_rollup",
      summary:
        "User Score Balance changes canonical user_intelligence.score. Workspace Health then aggregates those user scores into workspaceHealthIndex, strategicRiskIndex, high-performer/at-risk distribution, and readiness rollups, so workspace_intelligence.score can move after recalculation.",
      userScoreBalanceWeights: {
        core: round4(userScoreBalanceWeights.core ?? 0.82),
        professionalDiscipline: round4(userScoreBalanceWeights.professionalDiscipline ?? 0.18),
      },
      directWorkspaceWeightChangedByUserBalance: false,
      affectedWorkspaceIndexes: [
        "workspaceHealthIndex",
        "productivityIndex",
        "strategicRiskIndex",
        "attendanceReadinessIndex",
        "capacitySustainabilityIndex",
      ],
    },
  };
  const time = {
    computedAt: workspace.computedAt,
    coverageStart: workspace.coverageStart,
    coverageEnd: workspace.coverageEnd,
    attendanceClosedThroughDate: workspace.attendanceClosedThroughDate,
    intelligenceMode: workspace.intelligenceMode,
    snapshotDate: workspace.snapshotDate,
  };
  const scoreTrace = canonicalScoreTrace({
    scoreAuthority: "workspace_intelligence.score",
    formulaReadable: scoreCalculation.formulaReadable,
    finalScore: workspace.score,
    rawScoreBeforeRounding: scoreCalculation.rawScoreBeforeRounding,
    finalRoundedScore: scoreCalculation.finalRoundedScore,
    confidence: workspace.confidence,
    rawEvidence: (workspace.drivers || []).map((driver) => ({ label: driver })),
    normalizedEvidence: domainContributions,
    weightedContributions: domainContributions,
    aggregation: {
      mode: scoreCalculation.mode,
      formulaComponents: scoreCalculation.formulaComponents,
      weightedMean: scoreCalculation.weightedMean,
      weightedMedian: scoreCalculation.weightedMedian,
      weightedHarmonic: scoreCalculation.weightedHarmonic,
      balance: scoreCalculation.balance,
    },
    time,
  });
  const scoreTooltip = canonicalScoreTooltip({
    scoreAuthority: "workspace_intelligence.score",
    formulaReadable: scoreCalculation.formulaReadable,
    scoreTrace,
    positiveDrivers: [...(workspace.strengths || []), ...upward],
    negativeDrivers: [...(workspace.concerns || []), ...downward],
    confidence: workspace.confidence,
    time,
  });

  return {
    source: "enterprise_intelligence",
    scoreAuthority: "workspace_intelligence.score",
    formulaLabel: scoreCalculation.formulaLabel,
    formulaReadable: scoreCalculation.formulaReadable,
    finalScore: scoreOrNull(workspace.score),
    reconstructedFinalScore,
    rawScoreBeforeRounding: scoreCalculation.rawScoreBeforeRounding,
    finalRoundedScore: scoreCalculation.finalRoundedScore,
    confidence: scoreOrNull(workspace.confidence),
    scoreModel,
    domainContributions,
    formulaComponents: scoreCalculation.formulaComponents,
    scoreCalculation,
    scoreTrace,
    scoreTooltip,
    upwardPressures: upward,
    downwardPressures: downward,
    attendanceEffect: attendanceRow ? {
      score: attendanceRow.score,
      feedsDomain: "Workspace Health",
      index: "attendanceReadinessIndex",
      weight: attendanceRow.configuredWeight,
      normalizedWeight: attendanceRow.normalizedWeight,
      weightedContributionPoints: attendanceRow.weightedContributionPoints,
      finalScoreImpactVsNeutral: attendanceRow.finalScoreImpactVsNeutral,
      contributionPath: "direct_workspace_index",
      directOrIndirect: "direct",
      materiallyAffectsScore: Math.abs(attendanceRow.finalScoreImpactVsNeutral) > 0,
      summary: `Attendance Readiness is ${attendanceRow.score}/100 with a ${Math.round((attendanceRow.configuredWeight || 0) * 100)}% configured workspace-index weight and ${attendanceRow.weightedContributionPoints} weighted-mean contribution points before adaptive blending.`,
    } : null,
    workforceSustainabilityEffect: capacityRow ? {
      score: capacityRow.score,
      index: "capacitySustainabilityIndex",
      weight: capacityRow.configuredWeight,
      normalizedWeight: capacityRow.normalizedWeight,
      weightedContributionPoints: capacityRow.weightedContributionPoints,
      finalScoreImpactVsNeutral: capacityRow.finalScoreImpactVsNeutral,
    } : null,
    userScoreBalancePropagation: scoreCalculation.userScoreBalancePropagation,
    summary: downward.length
      ? `Workspace Health is ${scoreOrNull(workspace.score)}/100 from workspace_intelligence.score. Main downward pressure: ${downward.map((row) => `${row.label} (${row.score}/100)`).join(" and ")}.`
      : `Workspace Health is ${scoreOrNull(workspace.score)}/100 from workspace_intelligence.score.`,
    strengths: workspace.strengths || [],
    concerns: workspace.concerns || [],
    drivers: workspace.drivers || [],
    time,
  };
}

function buildForecastContract({ scoreHistory = [], workspace = null, executionContext = {}, rangeMeta = dashboardRangeMeta("30d") }) {
  const scores = (scoreHistory || [])
    .map((point) => Number(point.score))
    .filter(Number.isFinite);
  const trend = buildTrendAnalytics(scoreHistory);
  const currentScore = workspace?.score ?? scores[scores.length - 1] ?? null;
  if (scores.length < 3) {
    return {
      predictedAverage: currentScore,
      trend: trend.direction === "up" ? "improving" : trend.direction === "down" ? "declining" : "stable",
      direction: trend.direction,
      delta: trend.delta,
      riskProjection: String(workspace?.risk?.level || "unknown").toLowerCase(),
      confidence: "low",
      momentum: 0,
      currentScore,
      confidenceScore: workspace?.confidence ?? null,
      range: rangeMeta,
      source: "enterprise_intelligence_current_snapshot",
      reasoning:
        `Only ${scores.length} historical intelligence snapshot(s) are available for ${rangeMeta.label}. ` +
        `Outlook uses the current authoritative workspace intelligence posture until additional snapshot history is available.`,
    };
  }

  const forecast = advancedForecast(scores, {
    completionRate: Number(executionContext.completionRate || 0) / 100,
  });
  return {
    ...forecast,
    direction: trend.direction,
    delta: trend.delta,
    currentScore,
    confidenceScore: workspace?.confidence ?? null,
    range: rangeMeta,
    source: "enterprise_intelligence_snapshots",
    reasoning: forecast.reasoning || "Forecast is derived from enterprise intelligence snapshots, not recalculated from legacy score tables.",
  };
}

async function scopedAdminUsersAndProjects({ workspaceId, userId, role, snapshot }) {
  let scopedUsers = snapshot.users || [];
  let scopedProjects = snapshot.projects || [];

  if (role === "admin") {
    return { scopedUsers, scopedProjects };
  }

  const { rows: projects } = await pool.query(
    `SELECT DISTINCT project_id
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND project_id IS NOT NULL`,
    [workspaceId, userId]
  );
  const projectIds = new Set(projects.map((p) => String(p.project_id)));
  scopedProjects = scopedProjects.filter((project) => projectIds.has(String(project.projectId)));
  const { rows: members } = await pool.query(
    `SELECT DISTINCT assigned_to AS user_id
     FROM tasks
     WHERE workspace_id = $1
       AND project_id = ANY($2::uuid[])
       AND assigned_to IS NOT NULL`,
    [workspaceId, [...projectIds]]
  ).catch(() => ({ rows: [] }));
  const userIds = new Set([String(userId), ...members.map((m) => String(m.user_id))]);
  scopedUsers = scopedUsers.filter((user) => userIds.has(String(user.userId)));
  return { scopedUsers, scopedProjects };
}

export async function buildUserPerformanceResponse({ workspaceId, userId, role, month }) {
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const user = snapshot.currentUser;
  if (!user) return null;

  const dimensions = user.dimensions || {};
  const scoreExplanation = buildUserScoreExplanation(user);
  return {
    source: "enterprise_intelligence",
    requestedMonth: month || monthKey(),
    effectiveMonth: monthKey(),
    scoreSource: "enterprise_intelligence",
    score: user.score,
    explanation: (user.drivers || []).slice(0, 2).join(" ") || "",
    computedAt: user.computedAt,
    coverageStart: user.coverageStart,
    coverageEnd: user.coverageEnd,
    attendanceClosedThroughDate: user.attendanceClosedThroughDate,
    breakdown: {
      attendanceScore: user.attendance?.score ?? null,
      productivityScore: dimensions.deliveryEffectiveness?.score ?? user.score,
      executionReliability: dimensions.executionReliability?.score ?? null,
      deliveryEffectiveness: dimensions.deliveryEffectiveness?.score ?? null,
      collaborationHealth: dimensions.collaborationHealth?.score ?? null,
      workSustainability: dimensions.workSustainability?.score ?? null,
      professionalDiscipline: dimensions.professionalDiscipline?.score ?? null,
      hasAttendanceTracking: user.attendance?.metrics?.expectedWorkingDays > 0,
    },
    scoreExplanation,
    scoreTooltip: scoreExplanation.scoreTooltip,
    scoreTrace: scoreExplanation.scoreTrace,
    reasoning: {
      strengths: user.strengths,
      concerns: user.concerns,
      drivers: user.drivers,
      confidence: user.confidence,
      attendance: user.attendance,
      dimensions,
    },
    coaching: [
      ...(user.concerns || []).map((concern) => ({
        message: concern,
        expectedImpact: "Improves enterprise intelligence indicators",
      })),
    ],
    intelligence: {
      dimensions: {
        executionDiscipline: dimensions.executionReliability?.score ?? 0,
        timelinessIndex: dimensions.executionReliability?.metrics?.dueDateDiscipline ?? 0,
        workloadStress: 100 - (dimensions.workSustainability?.score ?? 0),
        velocityScore: dimensions.deliveryEffectiveness?.metrics?.velocity ?? 0,
      },
      enterpriseDimensions: dimensions,
      attendance: user.attendance,
      risk: user.risk,
      signals: (user.indicators || []).map((item) => item.label || item.type).filter(Boolean),
    },
  };
}

export async function buildAdminInsightsResponse({ workspaceId, userId, role, range = "30d" }) {
  const rangeMeta = dashboardRangeMeta(range);
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const { scopedUsers, scopedProjects } = await scopedAdminUsersAndProjects({ workspaceId, userId, role, snapshot });
  const scoreHistory = await getHistoricalSeries({
    workspaceId,
    scopeType: "workspace",
    subjectKey: String(workspaceId),
    range: rangeMeta.value,
  });
  const trend = buildTrendAnalytics(scoreHistory);
  const executionContext = {
    completionRate: snapshot.workspace?.indexes?.deliveryConfidenceIndex || null,
    backlog: scopedProjects.reduce((sum, project) => sum + (project.analytics?.openTasks || 0), 0),
    pressure: snapshot.workspace?.risk?.level === "High" ? "High" : snapshot.workspace?.risk?.level === "Medium" ? "Moderate" : "Stable",
    risk: snapshot.workspace?.risk?.level || "Low",
  };

  return {
    source: "enterprise_intelligence",
    dashboardRange: rangeMeta,
    orgScore: summarizeUsers(scopedUsers),
    coachingEffectiveness: {},
    riskDistribution: riskDistribution(scopedUsers),
    forecast: buildForecastContract({ scoreHistory, workspace: snapshot.workspace, executionContext, rangeMeta }),
    leaderboard: scopedUsers.slice(0, 5).map((user) => ({
      userId: user.userId,
      username: user.username,
      score: user.score,
      risk: user.risk,
    })),
    execution: executionContext,
    signals: [
      ...(snapshot.workspace?.indicators || []),
      ...(snapshot.workspace?.concerns || []).map((concern) => ({ type: "concern", label: concern })),
    ],
    analytics: {
      workspace: snapshot.workspace,
      users: scopedUsers,
      projects: scopedProjects,
      teams: snapshot.teams,
      trend,
    },
  };
}

export async function computeGoalWorkspaceHealth(workspaceId) {
  const { rows: objectives } = await pool.query(
    `SELECT id, title, status, progress, time_period, created_at
     FROM okr_objectives WHERE workspace_id = $1`,
    [workspaceId]
  );

  if (objectives.length === 0) {
    return {
      totalGoals: 0, byStatus: {}, atRiskCount: 0,
      stalledCount: 0, avgProgress: 0, avgHealthScore: null,
      behindCount: 0, completedCount: 0,
    };
  }

  const now = new Date();
  const summaries = objectives.map((obj) => {
    const tp = (obj.time_period || "").toUpperCase();
    const yearStr = tp.match(/(\d{4})/);
    const year = yearStr ? parseInt(yearStr[1], 10) : now.getFullYear();
    let startDate;
    let endDate;

    if (tp.includes("Q1")) { startDate = new Date(year, 0, 1); endDate = new Date(year, 2, 31); }
    else if (tp.includes("Q2")) { startDate = new Date(year, 3, 1); endDate = new Date(year, 5, 30); }
    else if (tp.includes("Q3")) { startDate = new Date(year, 6, 1); endDate = new Date(year, 8, 30); }
    else if (tp.includes("Q4")) { startDate = new Date(year, 9, 1); endDate = new Date(year, 11, 31); }
    else if (tp.includes("H1")) { startDate = new Date(year, 0, 1); endDate = new Date(year, 5, 30); }
    else if (tp.includes("H2")) { startDate = new Date(year, 6, 1); endDate = new Date(year, 11, 31); }
    else { startDate = new Date(year, 0, 1); endDate = new Date(year, 11, 31); }

    const totalDays = Math.max(1, (endDate - startDate) / 86400000);
    const daysElapsed = Math.max(0, Math.min(totalDays, (now - startDate) / 86400000));
    const expectedProgress = Math.min(100, (daysElapsed / totalDays) * 100);
    const actualProgress = Number(obj.progress) || 0;
    const progressGap = actualProgress - expectedProgress;

    let healthScore = 50;
    if (progressGap >= 15) healthScore += 25;
    else if (progressGap >= 5) healthScore += 15;
    else if (progressGap >= -10) healthScore += 0;
    else if (progressGap >= -20) healthScore -= 15;
    else healthScore -= 30;
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    return {
      status: obj.status,
      actualProgress,
      expectedProgress,
      progressGap,
      healthScore,
      isStalled: actualProgress === 0 && daysElapsed > 14,
      isBehind: progressGap < -10,
      isComplete: actualProgress >= 100,
    };
  });

  const byStatus = {};
  for (const summary of summaries) byStatus[summary.status] = (byStatus[summary.status] || 0) + 1;

  return {
    totalGoals: objectives.length,
    byStatus,
    atRiskCount: summaries.filter((summary) => summary.status === "at_risk" || summary.status === "off_track").length,
    stalledCount: summaries.filter((summary) => summary.isStalled).length,
    behindCount: summaries.filter((summary) => summary.isBehind).length,
    completedCount: summaries.filter((summary) => summary.isComplete).length,
    avgProgress: Math.round(summaries.reduce((sum, summary) => sum + summary.actualProgress, 0) / summaries.length),
    avgHealthScore: Math.round(summaries.reduce((sum, summary) => sum + summary.healthScore, 0) / summaries.length),
  };
}

export async function buildExecutiveSummaryData({ workspaceId, userId, role, month, range = "30d" }) {
  const rangeMeta = dashboardRangeMeta(range);
  const [snapshot, scoreHistory, rawGoalsHealth] = await Promise.all([
    getUnifiedIntelligenceSnapshot({ workspaceId, userId, role }),
    getHistoricalSeries({
      workspaceId,
      scopeType: "workspace",
      subjectKey: String(workspaceId),
      range: rangeMeta.value,
    }),
    computeGoalWorkspaceHealth(workspaceId),
  ]);
  const goalsHealth = withLegacyIsolation(rawGoalsHealth, {
    surface: "okr_goal_health_context",
    reason: "OKR health is contextual goal-module analytics and is excluded from core enterprise executive scoring.",
    replacement: "workspace_intelligence and project_intelligence",
  });

  const users = snapshot.users || [];
  const projects = snapshot.projects || [];
  const executionContext = {
    completionRate: snapshot.workspace?.indexes?.deliveryConfidenceIndex ?? null,
    backlog: projects.reduce((sum, project) => sum + (project.analytics?.openTasks || 0), 0),
  };

  return {
    month,
    source: "enterprise_intelligence",
    dashboardRange: rangeMeta,
    execution: {
      workspaceHealthIndex: snapshot.workspace?.score ?? null,
      deliveryConfidenceIndex: snapshot.workspace?.indexes?.deliveryConfidenceIndex ?? null,
      productivityIndex: snapshot.workspace?.indexes?.productivityIndex ?? null,
      strategicRiskIndex: snapshot.workspace?.indexes?.strategicRiskIndex ?? null,
    },
    executionContext,
    orgScore: summarizeUsers(users),
    riskDistribution: riskDistribution(users, "snake"),
    leaderboard: users.slice(0, 5).map((user) => ({
      user_id: user.userId,
      username: user.username,
      score: user.score,
      confidence: user.confidence,
      risk: user.risk,
    })),
    forecast: buildForecastContract({ scoreHistory, workspace: snapshot.workspace, executionContext, rangeMeta }),
    okrHealth: null,
    legacyContext: {
      okrHealth: goalsHealth,
    },
    intelligence: {
      workspace: snapshot.workspace,
      projects,
      teams: snapshot.teams || [],
    },
  };
}

export async function buildCoachingEffectivenessResponse({ workspaceId, userId, role, month }) {
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const users = snapshot.users || [];
  const concernCounts = new Map();
  for (const user of users) {
    for (const concern of user.concerns || []) {
      concernCounts.set(concern, (concernCounts.get(concern) || 0) + 1);
    }
  }
  return {
    source: "enterprise_intelligence",
    month: month || monthKey(),
    totalUsers: users.length,
    improving: users.filter((user) => user.trend === "up").length,
    stable: users.filter((user) => user.trend === "flat").length,
    declining: users.filter((user) => user.trend === "down").length,
    highRisk: users.filter((user) => user.risk?.level === "High").length,
    lowConfidence: users.filter((user) => Number(user.confidence) < 55).length,
    topCoachingThemes: [...concernCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({ label, count })),
  };
}

export async function buildUserTrendResponse({ workspaceId, userId, role, range }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const rows = await getHistoricalSeries({
    workspaceId,
    scopeType: "user",
    subjectKey: String(userId),
    range: range || "30d",
  });
  const series = rows.map((row) => ({
    month: String(row.date).slice(0, 7),
    date: row.date,
    score: row.score,
    computedAt: row.computedAt,
    coverageStart: row.coverageStart,
    coverageEnd: row.coverageEnd,
    attendanceClosedThroughDate: row.attendanceClosedThroughDate,
    snapshotDate: row.snapshotDate,
  }));
  return {
    source: "enterprise_intelligence",
    scopeType: "user",
    subjectKey: String(userId),
    range: range || "30d",
    trend: buildTrendAnalytics(series),
    series,
    rows: series,
  };
}

export async function buildUnifiedHistoryResponse({
  workspaceId,
  userId,
  role,
  scopeType,
  subjectKey,
  range,
  startDate,
  endDate,
}) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const series = await getHistoricalSeries({
    workspaceId,
    scopeType,
    subjectKey,
    range: range || "30d",
    startDate,
    endDate,
  });
  return {
    source: "enterprise_intelligence",
    scopeType,
    subjectKey,
    range: range || "30d",
    trend: buildTrendAnalytics(series),
    series,
  };
}

export async function buildUserProjectPerformanceResponse({ workspaceId, userId, role }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const { rows: assignedProjects } = await pool.query(
    `SELECT DISTINCT project_id
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND project_id IS NOT NULL`,
    [workspaceId, userId]
  );
  const projectIds = assignedProjects.map((row) => row.project_id);
  if (projectIds.length === 0) {
    return {
      source: "enterprise_intelligence",
      projects: [],
      rows: [],
    };
  }
  const projects = await listProjectIntelligence({ workspaceId, projectIds });

  const rows = projects.map((project) => ({
    ...(() => {
      const scoreExplanation = buildIndexScoreExplanation(project, {
        scoreAuthority: "project_intelligence.score",
        groupKey: "projectIndexes",
        fallbackLabel: "Project intelligence score",
      });
      return {
        scoreExplanation,
        scoreTooltip: scoreExplanation.scoreTooltip,
        scoreTrace: scoreExplanation.scoreTrace,
      };
    })(),
    project_id: project.projectId,
    project_name: project.projectName,
    score: project.score,
    band: project.band,
    risk: project.risk,
    indexes: project.indexes,
    computedAt: project.computedAt,
    coverageStart: project.coverageStart,
    coverageEnd: project.coverageEnd,
    attendanceClosedThroughDate: project.attendanceClosedThroughDate,
  }));
  return {
    source: "enterprise_intelligence",
    projects: rows,
    rows,
  };
}

export async function buildProjectsHealthResponse({ workspaceId, userId, role }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const intelligenceProjects = await listProjectIntelligence({ workspaceId });
  return {
    source: "enterprise_intelligence",
    projects: intelligenceProjects.map((project) => {
      const scoreExplanation = buildIndexScoreExplanation(project, {
        scoreAuthority: "project_intelligence.score",
        groupKey: "projectIndexes",
        fallbackLabel: "Project health score",
      });
      return {
        projectId: project.projectId,
        projectName: project.projectName,
        totalTasks: project.analytics?.totalTasks || 0,
        completedTasks: project.analytics?.completedTasks || 0,
        activeTasks: project.analytics?.openTasks || 0,
        overdueTasks: project.analytics?.overdueTasks || 0,
        completionRate: project.analytics?.completionRate || 0,
        healthScore: project.score,
        status: project.risk?.level === "High" ? "critical" : project.risk?.level === "Medium" ? "at_risk" : "healthy",
        indexes: project.indexes,
        confidence: project.confidence,
        indicators: project.indicators,
        scoreExplanation,
        scoreTooltip: scoreExplanation.scoreTooltip,
        scoreTrace: scoreExplanation.scoreTrace,
        computedAt: project.computedAt,
        coverageStart: project.coverageStart,
        coverageEnd: project.coverageEnd,
        attendanceClosedThroughDate: project.attendanceClosedThroughDate,
      };
    }),
  };
}

export async function buildTeamComparisonResponse({ workspaceId, userId, role, month }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const [users, teams] = await Promise.all([
    listUserIntelligence({ workspaceId }),
    listTeamIntelligence({ workspaceId }),
  ]);
  return {
    month,
    source: "enterprise_intelligence",
    surfaceClassification: "derived_user_comparison",
    authority: {
      scoreAuthority: "user_intelligence",
      canonicalTeamAuthority: "team_intelligence",
      teamScoreAuthority: false,
      dashboardScoreAuthority: false,
      purpose: "rank and compare user intelligence profiles in a team-style table without creating a canonical team score",
    },
    cutover: {
      status: "derived_comparison_surface",
      conflictsWithCanonicalTeamIntelligence: false,
      canonicalTeamRowsIncludedForReference: teams.length,
    },
    canonicalTeams: teams.map((team) => {
      const scoreExplanation = buildIndexScoreExplanation(team, {
        scoreAuthority: "team_intelligence.score",
        groupKey: "teamIndexes",
        fallbackLabel: "Team intelligence score",
      });
      return {
        teamKey: team.teamKey,
        managerId: team.managerId,
        managerName: team.managerName,
        score: team.score,
        band: team.band,
        indexes: team.indexes,
        confidence: team.confidence,
        scoreExplanation,
        scoreTooltip: scoreExplanation.scoreTooltip,
        scoreTrace: scoreExplanation.scoreTrace,
        computedAt: team.computedAt,
        coverageStart: team.coverageStart,
        coverageEnd: team.coverageEnd,
        attendanceClosedThroughDate: team.attendanceClosedThroughDate,
      };
    }),
    team: users.map((user) => {
      const scoreExplanation = buildUserScoreExplanation(user);
      return {
        userId: user.userId,
        username: user.username,
        avatarUrl: null,
        score: user.score,
        completedTasks: user.analytics?.completedWork || 0,
        overdueTasks: user.analytics?.overdueWork || 0,
        totalTasks: user.analytics?.assignedWork || 0,
        riskLevel: String(user.risk?.level || "medium").toLowerCase(),
        confidence: user.confidence,
        indicators: user.indicators,
        scoreExplanation,
        scoreTooltip: scoreExplanation.scoreTooltip,
        scoreTrace: scoreExplanation.scoreTrace,
        computedAt: user.computedAt,
        coverageStart: user.coverageStart,
        coverageEnd: user.coverageEnd,
        attendanceClosedThroughDate: user.attendanceClosedThroughDate,
      };
    }),
  };
}

export async function buildWorkspaceDashboardResponse({ workspaceId, userId, role }) {
  const month = monthKey();
  const [snapshot, scoringConfig] = await Promise.all([
    getUnifiedIntelligenceSnapshot({ workspaceId, userId, role }),
    getWorkspaceScoringConfig({ workspaceId }),
  ]);
  const workspaceIntel = snapshot.workspace;
  const [tasksRes, autopilotRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed,
         COUNT(*) FILTER (WHERE status = 'in-progress') AS in_progress,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < NOW()) AS overdue
       FROM tasks WHERE workspace_id = $1`,
      [workspaceId]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_actions,
         COUNT(*) FILTER (WHERE action_type = 'handle_overdue') AS overdue_actions,
         COUNT(*) FILTER (WHERE action_type = 'escalate') AS escalated_actions
       FROM autopilot_actions WHERE workspace_id = $1`,
      [workspaceId]
    ),
  ]);

  const tasks = tasksRes.rows[0] || {};
  const autopilot = autopilotRes.rows[0] || {};
  const totalTasks = Number(tasks.total) || 0;
  const completedTasks = Number(tasks.completed) || 0;
  const scoreExplanation = buildWorkspaceScoreExplanation(workspaceIntel || {}, { scoringConfig });

  return {
    month,
    source: "enterprise_intelligence",
    healthScore: workspaceIntel?.score ?? null,
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      inProgress: Number(tasks.in_progress) || 0,
      pending: Number(tasks.pending) || 0,
      overdue: Number(tasks.overdue) || 0,
      completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    },
    performance: {
      avgScore: workspaceIntel?.analytics?.averageUserScore ?? null,
      highPerformers: workspaceIntel?.analytics?.highPerformers || 0,
      atRisk: workspaceIntel?.analytics?.atRiskUsers || 0,
    },
    autopilot: {
      pendingActions: Number(autopilot.pending_actions) || 0,
      overdueActions: Number(autopilot.overdue_actions) || 0,
      escalatedActions: Number(autopilot.escalated_actions) || 0,
    },
    intelligence: workspaceIntel,
    scoreExplanation,
    scoreTooltip: scoreExplanation.scoreTooltip,
    scoreTrace: scoreExplanation.scoreTrace,
    computedAt: workspaceIntel?.computedAt || null,
    coverageStart: workspaceIntel?.coverageStart || null,
    coverageEnd: workspaceIntel?.coverageEnd || null,
    attendanceClosedThroughDate: workspaceIntel?.attendanceClosedThroughDate || null,
  };
}

export async function buildWorkspaceHealthResponse({ workspaceId, userId, role }) {
  const [snapshot, scoringConfig] = await Promise.all([
    getUnifiedIntelligenceSnapshot({ workspaceId, userId, role }),
    getWorkspaceScoringConfig({ workspaceId }),
  ]);
  const workspaceIntel = snapshot.workspace;
  const scoreExplanation = buildWorkspaceScoreExplanation(workspaceIntel || {}, { scoringConfig });
  return {
    source: "enterprise_intelligence",
    healthScore: workspaceIntel?.score ?? null,
    band: workspaceIntel?.band ?? null,
    trend: workspaceIntel?.trend ?? null,
    confidence: workspaceIntel?.confidence ?? null,
    strengths: workspaceIntel?.strengths || [],
    concerns: workspaceIntel?.concerns || [],
    drivers: workspaceIntel?.drivers || [],
    indexes: workspaceIntel?.indexes || {},
    scoreExplanation,
    scoreTooltip: scoreExplanation.scoreTooltip,
    scoreTrace: scoreExplanation.scoreTrace,
    risk: workspaceIntel?.risk || null,
    computedAt: workspaceIntel?.computedAt || null,
    coverageStart: workspaceIntel?.coverageStart || null,
    coverageEnd: workspaceIntel?.coverageEnd || null,
    attendanceClosedThroughDate: workspaceIntel?.attendanceClosedThroughDate || null,
  };
}

export default {
  buildUserPerformanceResponse,
  buildAdminInsightsResponse,
  computeGoalWorkspaceHealth,
  buildExecutiveSummaryData,
  buildCoachingEffectivenessResponse,
  buildUnifiedHistoryResponse,
  buildUserTrendResponse,
  buildUserProjectPerformanceResponse,
  buildProjectsHealthResponse,
  buildTeamComparisonResponse,
  buildWorkspaceDashboardResponse,
  buildWorkspaceHealthResponse,
};
