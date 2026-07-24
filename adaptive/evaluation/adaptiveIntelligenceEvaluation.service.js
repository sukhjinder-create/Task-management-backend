import pool from "../../db.js";

const EVALUATION_MODEL_VERSION = "aiep_business_outcome_evaluator_v1";
const DEFAULT_DAYS = 30;

const CATEGORY_DEFINITIONS = [
  { label: "Task delivery assistance", tokens: ["task", "followup", "deadline", "overdue", "blocked"] },
  { label: "Meeting follow-through", tokens: ["meeting", "huddle", "transcript", "decision"] },
  { label: "Delivery risk management", tokens: ["risk", "blocker", "escalat", "delivery", "dependency"] },
  { label: "Knowledge and memory improvement", tokens: ["memory", "knowledge", "wiki", "summary"] },
  { label: "Executive visibility", tokens: ["executive", "report", "workspace intelligence", "digest"] },
  { label: "Quality assurance", tokens: ["test", "qa", "defect", "regression"] },
  { label: "Workload balancing", tokens: ["workload", "attendance", "leave", "availability", "capacity"] },
  { label: "Communication and nudges", tokens: ["notify", "notification", "message", "reminder"] },
];

const CONTEXT_SOURCE_DEFINITIONS = [
  { label: "Meetings", tokens: ["meeting", "huddle", "transcript", "decision"] },
  { label: "Attendance", tokens: ["attendance", "availability", "leave", "pto"] },
  { label: "Knowledge", tokens: ["knowledge", "wiki", "memory"] },
  { label: "Executive summaries", tokens: ["executive", "summary", "digest"] },
  { label: "Workspace intelligence", tokens: ["workspace intelligence", "workspace score", "health"] },
  { label: "Historical behaviour", tokens: ["historical", "previous", "history", "prior"] },
  { label: "Manager preferences", tokens: ["manager", "preference", "approval bias"] },
  { label: "Department behaviour", tokens: ["department", "team behaviour", "team behavior"] },
  { label: "Reviews", tokens: ["review", "performance"] },
  { label: "Goals", tokens: ["goal", "okr", "objective"] },
  { label: "Risk", tokens: ["risk", "blocked", "blocker", "overdue"] },
  { label: "Project history", tokens: ["project", "sprint", "delivery"] },
  { label: "Dependency graph", tokens: ["dependency", "depends", "linked"] },
];

const CAPABILITY_LABELS = new Map([
  ["notification.send", "Notify the right people"],
  ["task.create", "Create follow-up work"],
  ["task.update", "Update work status"],
  ["workspace_memory.create", "Capture organizational memory"],
  ["executive_summary.generate", "Refresh executive visibility"],
  ["workspace_intelligence.generate", "Refresh workspace intelligence"],
  ["testing_agent.run", "Run quality checks"],
  ["autopilot.analyze", "Analyze delivery risk"],
  ["report.generate", "Prepare an operational report"],
]);

const STATUS_RESPONSE_SCORE = new Map([
  ["executed", 0.9],
  ["approved", 0.75],
  ["pending", 0.5],
  ["rejected", 0.2],
  ["failed", 0.15],
]);

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function average(values, fallback = null) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return fallback;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function round(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return Object.values(value).filter(Boolean);
  return [value];
}

function stringifyForMatching(value) {
  try {
    return JSON.stringify(value || {}).toLowerCase();
  } catch {
    return String(value || "").toLowerCase();
  }
}

function containsAny(text, tokens) {
  return tokens.some((token) => text.includes(token));
}

export function businessCategoryForAction(action = {}) {
  const text = stringifyForMatching([
    action.action_type,
    action.capability_key,
    action.title,
    action.summary,
    action.explanation,
    action.payload,
    action.evidence,
  ]);
  return CATEGORY_DEFINITIONS.find((definition) => containsAny(text, definition.tokens))?.label
    || "Operational assistance";
}

export function capabilityLabel(capabilityKey, actionType = "") {
  if (CAPABILITY_LABELS.has(capabilityKey)) return CAPABILITY_LABELS.get(capabilityKey);
  const text = `${capabilityKey || ""} ${actionType || ""}`.toLowerCase();
  if (text.includes("notif")) return "Notify the right people";
  if (text.includes("task")) return "Coordinate task work";
  if (text.includes("summary") || text.includes("report")) return "Improve leadership visibility";
  if (text.includes("memory") || text.includes("knowledge")) return "Capture organizational knowledge";
  if (text.includes("test")) return "Run quality checks";
  if (text.includes("auto") || text.includes("risk")) return "Analyze operational risk";
  return "Coordinate enterprise work";
}

export function contextContributionLabels({ action = {}, runtimeRun = {}, invocations = [] } = {}) {
  const text = stringifyForMatching([
    action.evidence,
    action.payload,
    runtimeRun.context_summary,
    runtimeRun.evidence,
    runtimeRun.reasoning_summary,
    invocations.map((item) => [item.input_summary, item.output_summary]),
  ]);
  const labels = CONTEXT_SOURCE_DEFINITIONS
    .filter((definition) => containsAny(text, definition.tokens))
    .map((definition) => definition.label);
  const unique = [...new Set(labels)];
  if (!unique.length) unique.push("Operational history");
  return unique.map((label) => ({
    label,
    contribution: "measured",
    explanation: `${label} was present in the evidence used for this recommendation.`,
  }));
}

function actualPositiveForPrediction(prediction = {}) {
  const actual = prediction.actual_value || {};
  const causal = prediction.causal_summary || {};
  if (typeof actual.accepted === "boolean") return actual.accepted;
  if (typeof actual.executed === "boolean") return actual.executed;
  if (typeof actual.success === "boolean") return actual.success;
  if (actual.result && typeof actual.result.improved === "boolean") return actual.result.improved;
  if (typeof causal.improved === "boolean") return causal.improved;
  if (typeof causal.regressed === "boolean") return !causal.regressed;
  return null;
}

function predictionProbability(prediction = {}) {
  return clamp(
    prediction.predicted_value?.probability
      ?? prediction.predicted_value?.confidence
      ?? prediction.confidence
      ?? 0.5,
    0,
    1
  );
}

export function confidenceCalibrationSummary(predictions = []) {
  const evaluated = predictions.filter((prediction) => prediction.status === "evaluated");
  const pending = predictions.filter((prediction) => prediction.status === "pending");
  const evaluatedWithActuals = evaluated
    .map((prediction) => ({
      prediction,
      probability: predictionProbability(prediction),
      actualPositive: actualPositiveForPrediction(prediction),
      score: Number(prediction.score),
    }))
    .filter((item) => item.actualPositive !== null);

  const falsePositives = evaluatedWithActuals.filter((item) => item.probability >= 0.6 && !item.actualPositive).length;
  const falseNegatives = evaluatedWithActuals.filter((item) => item.probability < 0.4 && item.actualPositive).length;
  const overconfident = evaluatedWithActuals.filter((item) => item.probability - (item.actualPositive ? 1 : 0) > 0.2).length;
  const underconfident = evaluatedWithActuals.filter((item) => (item.actualPositive ? 1 : 0) - item.probability > 0.2).length;
  const averageBrier = average(evaluated.map((prediction) => prediction.score), null);
  const averageAccuracy = average(evaluated.map((prediction) => 1 - Number(prediction.score || 0)), null);

  let calibration = "Not enough evaluated outcomes yet";
  if (evaluatedWithActuals.length >= 1) {
    const rate = (overconfident + underconfident) / evaluatedWithActuals.length;
    calibration = rate <= 0.25 ? "Well calibrated" : overconfident >= underconfident ? "Overconfident" : "Underconfident";
  }

  return {
    evaluated: evaluated.length,
    pending: pending.length,
    averageBrierScore: round(averageBrier, 4),
    averageAccuracy: round(averageAccuracy, 4),
    falsePositives,
    falseNegatives,
    overconfident,
    underconfident,
    calibration,
  };
}

function workflowScore(workflows = [], executionPlan = null) {
  const statuses = [...workflows.map((workflow) => workflow.status), executionPlan?.status].filter(Boolean);
  if (!statuses.length) return 0.5;
  if (statuses.some((status) => ["completed"].includes(status))) return 0.82;
  if (statuses.some((status) => ["failed", "cancelled"].includes(status))) return 0.18;
  if (statuses.some((status) => ["running", "waiting", "approval_pending", "approved", "partial"].includes(status))) return 0.56;
  return 0.5;
}

function learningScore(signals = []) {
  if (!signals.length) return 0.5;
  const positive = signals.filter((signal) => {
    const text = stringifyForMatching([signal.signal_key, signal.signal_value]);
    return text.includes("accepted") || text.includes("accuracy") || text.includes("success");
  }).length;
  const negative = signals.filter((signal) => {
    const text = stringifyForMatching([signal.signal_key, signal.signal_value]);
    return text.includes("rejected") || text.includes("ignored") || text.includes("failure");
  }).length;
  return clamp(0.5 + (positive * 0.08) - (negative * 0.08), 0.15, 0.85);
}

function outcomeScore(predictions = []) {
  const causalPredictions = predictions.filter((prediction) => {
    const text = stringifyForMatching([prediction.prediction_key, prediction.evaluation_strategy, prediction.causal_summary]);
    return text.includes("outcome") || text.includes("causal") || text.includes("delivery");
  });
  if (!causalPredictions.length) return 0.5;
  const values = causalPredictions.map((prediction) => {
    const causal = prediction.causal_summary || {};
    if (causal.improved) return 0.85;
    if (causal.regressed) return 0.15;
    if (Number.isFinite(Number(causal.delta))) return clamp(0.5 + Number(causal.delta), 0.1, 0.9);
    if (prediction.status === "evaluated" && Number.isFinite(Number(prediction.score))) return clamp(1 - Number(prediction.score), 0, 1);
    return 0.5;
  });
  return average(values, 0.5);
}

export function calculateEffectivenessScore({ action = {}, predictions = [], workflows = [], executionPlan = null, learningSignals = [] } = {}) {
  const responseScore = STATUS_RESPONSE_SCORE.get(String(action.status || "").toLowerCase()) ?? 0.5;
  const predictionAccuracy = average(
    predictions
      .filter((prediction) => prediction.status === "evaluated" && Number.isFinite(Number(prediction.score)))
      .map((prediction) => 1 - Number(prediction.score)),
    null
  );
  const predictionScore = predictionAccuracy ?? clamp(action.outcome_confidence ?? action.prediction_confidence ?? action.confidence ?? 0.5, 0, 1);
  const score = (
    responseScore * 0.28
    + predictionScore * 0.24
    + outcomeScore(predictions) * 0.24
    + workflowScore(workflows, executionPlan) * 0.14
    + learningScore(learningSignals) * 0.10
  );
  return round(clamp(score), 4);
}

function decisionLatencyMinutes(action = {}, decisions = []) {
  if (!action.created_at) return null;
  const decidedAt = decisions[0]?.created_at || action.approved_at || action.executed_at;
  if (!decidedAt) return null;
  const deltaMs = new Date(decidedAt).getTime() - new Date(action.created_at).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  return round(deltaMs / 60000, 1);
}

function businessOutcomeDimensions({ action = {}, category, predictions = [], decisions = [] } = {}) {
  const effectiveness = calculateEffectivenessScore({ action, predictions });
  const causalDelta = average(
    predictions
      .map((prediction) => prediction.causal_summary?.delta)
      .filter((value) => Number.isFinite(Number(value))),
    null
  );
  const accepted = ["approved", "executed"].includes(String(action.status || "").toLowerCase());
  const latency = decisionLatencyMinutes(action, decisions);
  return {
    dimensions: [
      { label: "Delivery", score: round(causalDelta === null ? effectiveness : clamp(0.5 + causalDelta), 3), evidence: causalDelta === null ? "No delivery outcome has matured yet." : `Delivery-health delta ${round(causalDelta, 3)} was measured.` },
      { label: "Task completion", score: action.task_id ? effectiveness : 0.5, evidence: action.task_id ? "The recommendation was attached to task work." : "No task-specific outcome was attached." },
      { label: "Meeting efficiency", score: category === "Meeting follow-through" ? effectiveness : 0.5, evidence: category === "Meeting follow-through" ? "The recommendation came from meeting follow-through work." : "No meeting-specific signal was attached." },
      { label: "Risk reduction", score: ["Delivery risk management", "Task delivery assistance"].includes(category) ? effectiveness : 0.5, evidence: "Risk impact is inferred from acceptance, workflow status, and outcome predictions." },
      { label: "Approval efficiency", score: latency === null ? 0.5 : clamp(1 - (latency / 1440), 0.1, 0.95), evidence: latency === null ? "No approval decision latency was available." : `Decision latency was ${latency} minutes.` },
      { label: "Executive visibility", score: ["Executive visibility", "Knowledge and memory improvement"].includes(category) ? effectiveness : 0.5, evidence: "Visibility impact is inferred from the recommendation category and capability mix." },
      { label: "User engagement", score: accepted ? 0.75 : action.status === "rejected" ? 0.25 : 0.5, evidence: accepted ? "The user or approver accepted the recommendation." : "The recommendation is pending or was not accepted." },
      { label: "Operational efficiency", score: effectiveness, evidence: "Composite score from response, prediction accuracy, workflow progress, and learning quality." },
    ],
    causalDelta: round(causalDelta, 4),
    decisionLatencyMinutes: latency,
    accepted,
  };
}

function lifecycleForAction({ action = {}, runtimeRun = {}, predictions = [], workflows = [], learningSignals = [] } = {}) {
  const responseStatus = String(action.status || "pending").toLowerCase();
  return {
    stages: [
      { label: "Problem detected", measured: Boolean(action.created_at || runtimeRun.started_at), at: runtimeRun.started_at || action.created_at || null },
      { label: "Context collected", measured: Boolean(runtimeRun.context_summary && Object.keys(runtimeRun.context_summary || {}).length), at: runtimeRun.started_at || null },
      { label: "Reasoning generated", measured: Boolean(runtimeRun.reasoning_summary || action.explanation), at: runtimeRun.completed_at || null },
      { label: "Recommendation produced", measured: Boolean(action.id), at: action.created_at || null },
      { label: "User response", measured: responseStatus !== "pending", value: responseStatus === "pending" ? "Waiting for response" : responseStatus },
      { label: "Workflow executed", measured: workflows.some((workflow) => ["completed", "failed", "cancelled"].includes(workflow.status)), value: workflows[0]?.status || "No workflow execution yet" },
      { label: "Business outcome", measured: predictions.some((prediction) => prediction.status === "evaluated"), value: predictions.some((prediction) => prediction.status === "evaluated") ? "Outcome evaluated" : "Outcome still pending" },
      { label: "Learning recorded", measured: learningSignals.length > 0, value: learningSignals.length ? `${learningSignals.length} learning signal(s)` : "No learning signal yet" },
      { label: "Future behaviour change", measured: learningSignals.some((signal) => signal.source === "continuous_evaluation" || stringifyForMatching(signal.signal_key).includes("preference")), value: "Tracked through adaptive learning profiles" },
    ],
  };
}

function learningSummary(signals = []) {
  const active = signals.filter((signal) => signal.status !== "reversed");
  const reversed = signals.filter((signal) => signal.status === "reversed");
  const labels = active.slice(0, 5).map((signal) => {
    const key = String(signal.signal_key || "");
    if (key.includes("accepted")) return "Accepted recommendation";
    if (key.includes("rejected")) return "Rejected recommendation";
    if (key.includes("ignored")) return "Ignored recommendation";
    if (key.includes("accuracy")) return "Prediction accuracy update";
    return "Operational learning signal";
  });
  return {
    activeSignals: active.length,
    reversedSignals: reversed.length,
    learningChanges: [...new Set(labels)],
    explanation: active.length
      ? "Learning signals from this lifecycle are available for future personalization and calibration."
      : "No learning signal has been recorded for this lifecycle yet.",
  };
}

function strategySummary({ action = {}, category, workflows = [] } = {}) {
  const approvalMode = String(action.approval_mode || "approval_required");
  return {
    planningApproach: category,
    approvalApproach: approvalMode === "automatic" ? "Automatic execution" : approvalMode === "manual_only" ? "Manual-only guidance" : "Approval before action",
    workflowUse: workflows.length ? "Workflow-assisted execution" : "Single recommendation",
    timing: action.created_at ? "Triggered from recent operational activity" : "Timing not available",
  };
}

function explainabilitySummary({ action = {}, category, contextSummary = [], predictions = [], learning = {}, effectivenessScore } = {}) {
  const calibration = confidenceCalibrationSummary(predictions);
  const outcomeText = effectivenessScore >= 0.67
    ? "The recommendation is currently helping based on available outcome evidence."
    : effectivenessScore <= 0.4
      ? "The recommendation needs review because available evidence is weak or negative."
      : "The recommendation has mixed or still-maturing evidence.";
  return {
    recommendation: category,
    whyRecommended: action.explanation || action.summary || "Asystence detected an operational pattern that may need attention.",
    contextUsed: contextSummary.map((item) => item.label),
    predictedConfidence: round(action.outcome_confidence ?? action.prediction_confidence ?? action.confidence ?? null, 3),
    confidenceCalibration: calibration.calibration,
    outcome: outcomeText,
    wouldRecommendAgain: effectivenessScore >= 0.55 && String(action.status || "").toLowerCase() !== "rejected",
    learningChanges: learning.learningChanges || [],
    evaluationModel: EVALUATION_MODEL_VERSION,
  };
}

function capabilitySummary(action = {}, invocations = []) {
  const labels = new Set();
  if (action.capability_key || action.action_type) labels.add(capabilityLabel(action.capability_key, action.action_type));
  for (const invocation of invocations) labels.add(capabilityLabel(invocation.capability_key));
  return [...labels].map((label) => ({
    label,
    contribution: "measured",
  }));
}

export function buildEvaluationRecord(actionRow = {}) {
  const runtimeRun = actionRow.runtime_run || {};
  const predictions = safeArray(actionRow.predictions);
  const learningSignals = safeArray(actionRow.learning_signals);
  const decisions = safeArray(actionRow.decisions);
  const workflows = safeArray(actionRow.workflow_runs);
  const invocations = safeArray(actionRow.invocations);
  const executionPlan = actionRow.execution_plan || null;
  const category = businessCategoryForAction(actionRow);
  const contextSummary = contextContributionLabels({ action: actionRow, runtimeRun, invocations });
  const learning = learningSummary(learningSignals);
  const effectivenessScore = calculateEffectivenessScore({ action: actionRow, predictions, workflows, executionPlan, learningSignals });
  const businessOutcomes = businessOutcomeDimensions({ action: actionRow, category, predictions, decisions });

  return {
    workspaceId: actionRow.workspace_id,
    actionId: actionRow.id,
    runtimeRunId: actionRow.adaptive_runtime_run_id,
    eventId: runtimeRun.event_id || null,
    executionPlanId: actionRow.execution_plan_id || executionPlan?.id || null,
    workflowRunIds: workflows.map((workflow) => workflow.id).filter(Boolean),
    lifecycle: lifecycleForAction({ action: actionRow, runtimeRun, predictions, workflows, learningSignals }),
    recommendationCategory: category,
    strategySummary: strategySummary({ action: actionRow, category, workflows }),
    capabilitySummary: capabilitySummary(actionRow, invocations),
    contextSummary,
    businessOutcomes,
    confidenceCalibration: confidenceCalibrationSummary(predictions),
    learningSummary: learning,
    explainability: explainabilitySummary({ action: actionRow, category, contextSummary, predictions, learning, effectivenessScore }),
    effectivenessScore,
    dataQuality: {
      predictionCount: predictions.length,
      evaluatedPredictionCount: predictions.filter((prediction) => prediction.status === "evaluated").length,
      workflowCount: workflows.length,
      learningSignalCount: learningSignals.length,
      hasRuntimeTrace: Boolean(actionRow.adaptive_runtime_run_id),
      notes: predictions.length ? [] : ["No prediction record was attached to this recommendation yet."],
    },
    evaluationWindow: "recent_action",
    idempotencyKey: `aiep:action:${actionRow.id}`,
  };
}

async function loadRecentActionRows({ workspaceId, days = DEFAULT_DAYS, limit = 100 }) {
  const { rows } = await pool.query(
    `
    SELECT
      a.*,
      CASE WHEN r.id IS NULL THEN '{}'::jsonb ELSE to_jsonb(r) END AS runtime_run,
      CASE WHEN ep.id IS NULL THEN NULL ELSE to_jsonb(ep) END AS execution_plan,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.predicted_at DESC), '[]'::jsonb)
        FROM adaptive_predictions p
        WHERE p.workspace_id = a.workspace_id AND p.action_id = a.id
      ) AS predictions,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC), '[]'::jsonb)
        FROM adaptive_learning_signals s
        WHERE s.workspace_id = a.workspace_id AND s.action_id = a.id
      ) AS learning_signals,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC), '[]'::jsonb)
        FROM operations_ai_action_decisions d
        WHERE d.workspace_id = a.workspace_id AND d.action_id = a.id
      ) AS decisions,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.started_at DESC), '[]'::jsonb)
        FROM adaptive_workflow_runs w
        WHERE w.workspace_id = a.workspace_id AND w.runtime_run_id = a.adaptive_runtime_run_id
      ) AS workflow_runs,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.started_at DESC), '[]'::jsonb)
        FROM adaptive_capability_invocations i
        WHERE i.workspace_id = a.workspace_id AND i.runtime_run_id = a.adaptive_runtime_run_id
      ) AS invocations
    FROM operations_ai_actions a
    LEFT JOIN adaptive_runtime_runs r ON r.id = a.adaptive_runtime_run_id AND r.workspace_id = a.workspace_id
    LEFT JOIN adaptive_execution_plans ep ON ep.id = a.execution_plan_id AND ep.workspace_id = a.workspace_id
    WHERE a.workspace_id = $1
      AND a.source = 'adaptive_runtime'
      AND a.created_at >= NOW() - ($2::int * INTERVAL '1 day')
    ORDER BY a.created_at DESC
    LIMIT $3
    `,
    [workspaceId, Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), 365), Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return rows;
}

async function upsertEvaluation(record) {
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_intelligence_evaluations (
      workspace_id, action_id, runtime_run_id, event_id, execution_plan_id, workflow_run_ids,
      lifecycle, recommendation_category, strategy_summary, capability_summary, context_summary,
      business_outcomes, confidence_calibration, learning_summary, explainability,
      effectiveness_score, data_quality, evaluation_window, idempotency_key, evaluated_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,
      $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18,$19,NOW(),NOW()
    )
    ON CONFLICT (workspace_id, idempotency_key)
    DO UPDATE SET
      runtime_run_id = EXCLUDED.runtime_run_id,
      event_id = EXCLUDED.event_id,
      execution_plan_id = EXCLUDED.execution_plan_id,
      workflow_run_ids = EXCLUDED.workflow_run_ids,
      lifecycle = EXCLUDED.lifecycle,
      recommendation_category = EXCLUDED.recommendation_category,
      strategy_summary = EXCLUDED.strategy_summary,
      capability_summary = EXCLUDED.capability_summary,
      context_summary = EXCLUDED.context_summary,
      business_outcomes = EXCLUDED.business_outcomes,
      confidence_calibration = EXCLUDED.confidence_calibration,
      learning_summary = EXCLUDED.learning_summary,
      explainability = EXCLUDED.explainability,
      effectiveness_score = EXCLUDED.effectiveness_score,
      data_quality = EXCLUDED.data_quality,
      evaluation_window = EXCLUDED.evaluation_window,
      evaluated_at = NOW(),
      updated_at = NOW()
    RETURNING *
    `,
    [
      record.workspaceId,
      record.actionId,
      record.runtimeRunId,
      record.eventId,
      record.executionPlanId,
      JSON.stringify(record.workflowRunIds),
      JSON.stringify(record.lifecycle),
      record.recommendationCategory,
      JSON.stringify(record.strategySummary),
      JSON.stringify(record.capabilitySummary),
      JSON.stringify(record.contextSummary),
      JSON.stringify(record.businessOutcomes),
      JSON.stringify(record.confidenceCalibration),
      JSON.stringify(record.learningSummary),
      JSON.stringify(record.explainability),
      record.effectivenessScore,
      JSON.stringify(record.dataQuality),
      record.evaluationWindow,
      record.idempotencyKey,
    ]
  );
  return rows[0];
}

export async function refreshWorkspaceAiepEvaluations({ workspaceId, days = DEFAULT_DAYS, limit = 100 } = {}) {
  const actionRows = await loadRecentActionRows({ workspaceId, days, limit });
  const evaluations = [];
  for (const actionRow of actionRows) {
    evaluations.push(await upsertEvaluation(buildEvaluationRecord(actionRow)));
  }
  return {
    refreshed: evaluations.length,
    evaluatedActions: actionRows.length,
    latestEvaluationAt: evaluations[0]?.evaluated_at || null,
  };
}

function summarizeRecords(records = []) {
  const total = records.length;
  const averageEffectiveness = round(average(records.map((record) => record.effectiveness_score), 0), 4);
  const response = { accepted: 0, rejected: 0, pending: 0, executed: 0 };
  const categoryMap = new Map();
  const capabilityMap = new Map();
  const contextMap = new Map();
  const calibration = {
    evaluated: 0,
    pending: 0,
    falsePositives: 0,
    falseNegatives: 0,
    overconfident: 0,
    underconfident: 0,
  };
  for (const record of records) {
    const stages = safeArray(record.lifecycle?.stages);
    const responseStage = stages.find((stage) => stage.label === "User response");
    const responseValue = String(responseStage?.value || "pending").toLowerCase();
    if (responseValue.includes("executed")) response.executed += 1;
    else if (responseValue.includes("approved")) response.accepted += 1;
    else if (responseValue.includes("rejected")) response.rejected += 1;
    else response.pending += 1;

    const category = record.recommendation_category || "Operational assistance";
    const categoryEntry = categoryMap.get(category) || { label: category, count: 0, scoreTotal: 0 };
    categoryEntry.count += 1;
    categoryEntry.scoreTotal += Number(record.effectiveness_score || 0);
    categoryMap.set(category, categoryEntry);

    for (const capability of safeArray(record.capability_summary)) {
      const label = capability.label || "Enterprise coordination";
      const entry = capabilityMap.get(label) || { label, count: 0, scoreTotal: 0 };
      entry.count += 1;
      entry.scoreTotal += Number(record.effectiveness_score || 0);
      capabilityMap.set(label, entry);
    }

    for (const context of safeArray(record.context_summary)) {
      const label = context.label || "Operational history";
      const entry = contextMap.get(label) || { label, count: 0, scoreTotal: 0 };
      entry.count += 1;
      entry.scoreTotal += Number(record.effectiveness_score || 0);
      contextMap.set(label, entry);
    }

    calibration.evaluated += Number(record.confidence_calibration?.evaluated || 0);
    calibration.pending += Number(record.confidence_calibration?.pending || 0);
    calibration.falsePositives += Number(record.confidence_calibration?.falsePositives || 0);
    calibration.falseNegatives += Number(record.confidence_calibration?.falseNegatives || 0);
    calibration.overconfident += Number(record.confidence_calibration?.overconfident || 0);
    calibration.underconfident += Number(record.confidence_calibration?.underconfident || 0);
  }

  const ranked = (map) => [...map.values()]
    .map((entry) => ({ ...entry, averageEffectiveness: round(entry.scoreTotal / Math.max(entry.count, 1), 4) }))
    .sort((a, b) => b.averageEffectiveness - a.averageEffectiveness || b.count - a.count);

  return {
    totalEvaluations: total,
    averageEffectiveness,
    recommendationResponse: response,
    strategyEffectiveness: ranked(categoryMap),
    capabilityEffectiveness: ranked(capabilityMap),
    contextEffectiveness: ranked(contextMap),
    confidenceCalibration: {
      ...calibration,
      calibrationStatus: calibration.evaluated === 0
        ? "Waiting for evaluated outcomes"
        : calibration.overconfident > calibration.underconfident
          ? "Watch overconfidence"
          : calibration.underconfident > calibration.overconfident
            ? "Watch underconfidence"
            : "Balanced",
    },
  };
}

async function loadWorkspaceEvaluationRecords({ workspaceId, days = DEFAULT_DAYS, limit = 250 }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM adaptive_intelligence_evaluations
    WHERE workspace_id = $1
      AND evaluated_at >= NOW() - ($2::int * INTERVAL '1 day')
    ORDER BY evaluated_at DESC
    LIMIT $3
    `,
    [workspaceId, Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), 365), Math.min(Math.max(Number(limit) || 250, 1), 1000)]
  );
  return rows;
}

async function workspaceRuntimeTelemetry({ workspaceId, days = DEFAULT_DAYS }) {
  const [runs, queue, workflows] = await Promise.all([
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
        AVG((timings->>'totalMs')::numeric) FILTER (WHERE timings ? 'totalMs') AS average_runtime_ms,
        MAX(completed_at) AS last_completed_at
      FROM adaptive_runtime_runs
      WHERE workspace_id = $1
        AND started_at >= NOW() - ($2::int * INTERVAL '1 day')
      `,
      [workspaceId, days]
    ),
    pool.query(
      `
      SELECT status, COUNT(*)::int AS count
      FROM adaptive_event_queue
      WHERE workspace_id = $1
      GROUP BY status
      `,
      [workspaceId]
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_workflows,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_workflows,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_workflows
      FROM adaptive_workflow_runs
      WHERE workspace_id = $1
        AND started_at >= NOW() - ($2::int * INTERVAL '1 day')
      `,
      [workspaceId, days]
    ),
  ]);
  return {
    runs: {
      ...runs.rows[0],
      average_runtime_ms: round(runs.rows[0]?.average_runtime_ms, 1),
    },
    queue: Object.fromEntries(queue.rows.map((row) => [row.status, row.count])),
    workflows: workflows.rows[0] || {},
  };
}

async function storeMetricSnapshot({ scopeType, workspaceId = null, snapshotKey, days, metrics, dataQuality = {} }) {
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_intelligence_metric_snapshots (
      scope_type, workspace_id, snapshot_key, window_start, window_end, metrics, data_quality
    ) VALUES (
      $1, $2, $3, NOW() - ($4::int * INTERVAL '1 day'), NOW(), $5::jsonb, $6::jsonb
    )
    RETURNING *
    `,
    [scopeType, workspaceId, snapshotKey, Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), 365), JSON.stringify(metrics), JSON.stringify(dataQuality)]
  );
  return rows?.[0] || null;
}

export async function getWorkspaceAiepDashboard({ workspaceId, days = DEFAULT_DAYS, refresh = true } = {}) {
  const boundedDays = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), 365);
  const refreshResult = refresh
    ? await refreshWorkspaceAiepEvaluations({ workspaceId, days: boundedDays, limit: 150 })
    : { refreshed: 0 };
  const records = await loadWorkspaceEvaluationRecords({ workspaceId, days: boundedDays });
  const summary = summarizeRecords(records);
  const telemetry = await workspaceRuntimeTelemetry({ workspaceId, days: boundedDays });
  const recentExplanations = records.slice(0, 10).map((record) => ({
    evaluationId: record.id,
    recommendation: record.explainability?.recommendation || record.recommendation_category,
    whyRecommended: record.explainability?.whyRecommended,
    outcome: record.explainability?.outcome,
    wouldRecommendAgain: record.explainability?.wouldRecommendAgain,
    effectivenessScore: round(record.effectiveness_score, 4),
    evaluatedAt: record.evaluated_at,
  }));
  const dashboard = {
    scope: "workspace",
    windowDays: boundedDays,
    generatedAt: new Date().toISOString(),
    refresh: refreshResult,
    headline: {
      isAdaptiveIntelligenceHelping: summary.totalEvaluations === 0
        ? "Not enough evidence yet"
        : summary.averageEffectiveness >= 0.62
          ? "Yes, with measurable positive signals"
          : summary.averageEffectiveness <= 0.42
            ? "Needs attention"
            : "Mixed or still maturing",
      averageEffectiveness: summary.averageEffectiveness,
      evaluatedRecommendations: summary.totalEvaluations,
    },
    ...summary,
    recentExplanations,
    observability: telemetry,
    dataQuality: {
      enoughEvidence: summary.totalEvaluations >= 5,
      notes: summary.totalEvaluations
        ? []
        : ["AIEP is installed, but this workspace has no adaptive recommendation lifecycle data in the selected window."],
    },
  };
  await storeMetricSnapshot({
    scopeType: "workspace",
    workspaceId,
    snapshotKey: `workspace-${boundedDays}d`,
    days: boundedDays,
    metrics: dashboard,
    dataQuality: dashboard.dataQuality,
  });
  return dashboard;
}

export async function getWorkspaceAiepExplainability({ workspaceId, evaluationId }) {
  const { rows } = await pool.query(
    `
    SELECT id, recommendation_category, lifecycle, strategy_summary, capability_summary,
           context_summary, business_outcomes, confidence_calibration, learning_summary,
           explainability, effectiveness_score, data_quality, evaluated_at
    FROM adaptive_intelligence_evaluations
    WHERE workspace_id = $1 AND id = $2
    LIMIT 1
    `,
    [workspaceId, evaluationId]
  );
  return rows[0] || null;
}

export async function getPlatformAiepDashboard({ days = DEFAULT_DAYS } = {}) {
  const boundedDays = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), 365);
  const { rows } = await pool.query(
    `
    SELECT *
    FROM adaptive_intelligence_evaluations
    WHERE evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY evaluated_at DESC
    LIMIT 2000
    `,
    [boundedDays]
  );
  const summary = summarizeRecords(rows);
  const [tenantCounts, runtimeHealth] = await Promise.all([
    pool.query(
      `
      SELECT COUNT(DISTINCT workspace_id)::int AS active_workspaces
      FROM adaptive_intelligence_evaluations
      WHERE evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
      `,
      [boundedDays]
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
        AVG((timings->>'totalMs')::numeric) FILTER (WHERE timings ? 'totalMs') AS average_runtime_ms
      FROM adaptive_runtime_runs
      WHERE started_at >= NOW() - ($1::int * INTERVAL '1 day')
      `,
      [boundedDays]
    ),
  ]);
  const dashboard = {
    scope: "platform",
    windowDays: boundedDays,
    generatedAt: new Date().toISOString(),
    tenantSafety: {
      aggregateOnly: true,
      workspaceNamesIncluded: false,
      workspaceIdsIncluded: false,
      customerContentIncluded: false,
    },
    activeWorkspaceCount: tenantCounts.rows[0]?.active_workspaces || 0,
    headline: {
      platformAdaptiveImpact: summary.totalEvaluations === 0
        ? "No evaluated adaptive intelligence data yet"
        : summary.averageEffectiveness >= 0.62
          ? "Positive platform-level impact"
          : summary.averageEffectiveness <= 0.42
            ? "Platform-level tuning required"
            : "Mixed platform-level impact",
      averageEffectiveness: summary.averageEffectiveness,
      evaluatedRecommendations: summary.totalEvaluations,
    },
    ...summary,
    observability: {
      runtime: {
        ...runtimeHealth.rows[0],
        average_runtime_ms: round(runtimeHealth.rows[0]?.average_runtime_ms, 1),
      },
    },
    dataQuality: {
      enoughEvidence: summary.totalEvaluations >= 20,
      notes: summary.totalEvaluations
        ? []
        : ["AIEP is installed, but no aggregate evaluation snapshots exist in the selected window."],
    },
  };
  await storeMetricSnapshot({
    scopeType: "platform",
    snapshotKey: `platform-${boundedDays}d`,
    days: boundedDays,
    metrics: dashboard,
    dataQuality: dashboard.dataQuality,
  });
  return dashboard;
}
