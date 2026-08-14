import { createHash } from "crypto";
import pool from "../db.js";
import { logAudit } from "./audit.service.js";
import { notifyUser } from "./notification.service.js";
import {
  getAssuranceCommitmentDetail,
  getAssuranceOverview,
} from "./executionAssurance.service.js";
import { queueImpactedIntelligenceRecalculation } from "../intelligence/realtime/recalculation.service.js";

const MANAGER_ROLES = new Set(["manager", "admin"]);
const DECISION_TYPES = new Set(["execution", "scope", "capacity", "risk", "evidence", "experiment", "policy", "other"]);
const REVERSIBILITY = new Set(["reversible", "partially_reversible", "irreversible"]);
const EFFECTIVENESS = new Set(["effective", "mixed", "ineffective", "inconclusive"]);
const EXPERIMENT_STATUSES = new Set(["planned", "active", "completed", "cancelled"]);
const EXPERIMENT_RESULTS = new Set(["not_recorded", "supported", "refuted", "inconclusive"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(message, statusCode = 400, code = "DECISION_OUTCOME_INVALID_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizedRole(role) {
  return String(role || "user").toLowerCase();
}

function assertManager(role) {
  if (!MANAGER_ROLES.has(normalizedRole(role))) {
    throw httpError("Manager access is required", 403, "ASSURANCE_FORBIDDEN");
  }
}

function assertAdmin(role) {
  if (normalizedRole(role) !== "admin") {
    throw httpError("Workspace admin access is required", 403, "ASSURANCE_FORBIDDEN");
  }
}

function cleanText(value, maxLength, { required = false, label = "Value" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw httpError(`${label} is required`);
  if (text.length > maxLength) throw httpError(`${label} must be ${maxLength} characters or fewer`);
  return text || null;
}

function uuidValue(value, label = "Identifier") {
  const id = cleanText(value, 100, { required: true, label });
  if (!UUID.test(id)) throw httpError(`${label} is not valid`);
  return id;
}

function dateValue(value, label = "Date") {
  if (value == null || value === "") return null;
  const date = String(value).slice(0, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!ISO_DATE.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError(`${label} is not valid`);
  }
  return date;
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw httpError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function uniqueTextList(value, maxItems = 12, maxLength = 1000) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function evidenceRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (typeof item === "string") return cleanText(item, 500);
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const type = cleanText(item.type, 50);
    const id = cleanText(item.id, 200);
    const label = cleanText(item.label, 500);
    return type || id || label ? { type, id, label } : null;
  }).filter(Boolean);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function queueRefresh({ workspaceId, sourceId = null, change, database = pool }) {
  if (database !== pool) return;
  queueImpactedIntelligenceRecalculation({
    workspaceId,
    reason: "decision_outcome_changed",
    sourceType: "decision_outcome",
    sourceId,
    metadata: { change },
  });
}

async function requireVisibleOutcome({ workspaceId, goalId, actorId, role, database = pool, now = new Date() }) {
  const id = uuidValue(goalId, "Outcome");
  const detail = await getAssuranceCommitmentDetail({
    id,
    workspaceId,
    userId: actorId,
    role,
    database,
    now,
  });
  return detail.commitment;
}

async function assertActiveWorkspaceUser(workspaceId, userId, database = pool) {
  const id = uuidValue(userId, "Owner");
  const { rows } = await database.query(
    `SELECT u.id FROM users u
     JOIN workspace_users wu ON wu.user_id=u.id AND wu.workspace_id=$1
     WHERE u.workspace_id=$1 AND u.id=$2 AND wu.billing_status!='pending'
       AND COALESCE(u.is_system, FALSE)=FALSE AND u.role!='system' LIMIT 1`,
    [workspaceId, id]
  );
  if (!rows[0]) throw httpError("Owner is not an active workspace member");
  return id;
}

export function normalizeDecisionInput(input = {}, { reviewDays = 30, now = new Date() } = {}) {
  const decisionType = String(input.decisionType ?? input.decision_type ?? "execution").toLowerCase();
  if (!DECISION_TYPES.has(decisionType)) throw httpError("Decision type is not supported");
  const reversibility = String(input.reversibility || "reversible").toLowerCase();
  if (!REVERSIBILITY.has(reversibility)) throw httpError("Reversibility is not supported");
  const confidenceValue = input.confidence == null || input.confidence === ""
    ? null
    : Math.round(boundedNumber(input.confidence, null, 0, 100, "Confidence"));
  const reviewDueAt = input.reviewDueAt ?? input.review_due_at;
  const fallbackReviewDate = new Date(now);
  fallbackReviewDate.setUTCDate(fallbackReviewDate.getUTCDate() + Math.max(1, Math.min(180, Number(reviewDays) || 30)));
  return {
    decisionType,
    question: cleanText(input.question, 1000, { required: true, label: "Decision question" }),
    selectedOption: cleanText(input.selectedOption ?? input.selected_option, 1000, { required: true, label: "Selected option" }),
    alternatives: uniqueTextList(input.alternatives, 12, 1000),
    rationale: cleanText(input.rationale, 4000, { required: true, label: "Decision rationale" }),
    expectedEffect: cleanText(input.expectedEffect ?? input.expected_effect, 2000, { label: "Expected effect" }),
    confidence: confidenceValue,
    reversibility,
    reviewDueAt: reviewDueAt === null ? null : dateValue(reviewDueAt || fallbackReviewDate.toISOString().slice(0, 10), "Review date"),
  };
}

export async function createAssuranceDecision({ workspaceId, goalId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertManager(role);
  const outcome = await requireVisibleOutcome({ workspaceId, goalId, actorId, role, database, now });
  const policyResult = await database.query(
    `SELECT COALESCE(decision_review_days, 30)::int AS review_days
     FROM assurance_workspace_policies WHERE workspace_id=$1`,
    [workspaceId]
  );
  const value = normalizeDecisionInput(input, { reviewDays: policyResult.rows[0]?.review_days || 30, now });
  const { rows } = await database.query(
    `INSERT INTO assurance_decisions (
       workspace_id, goal_id, decision_type, question, selected_option,
       alternatives, rationale, expected_effect, confidence, reversibility,
       recorded_by, decided_at, review_due_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      workspaceId, outcome.id, value.decisionType, value.question, value.selectedOption,
      JSON.stringify(value.alternatives), value.rationale, value.expectedEffect, value.confidence,
      value.reversibility, actorId, now.toISOString(), value.reviewDueAt,
    ]
  );
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.decision.record",
    entityType: "assurance_decision",
    entityId: rows[0].id,
    newValue: { goalId: outcome.id, decisionType: value.decisionType, selectedOption: value.selectedOption, reviewDueAt: value.reviewDueAt },
  });
  if (outcome.owner_id && String(outcome.owner_id) !== String(actorId)) {
    await notifyUser({
      user_id: outcome.owner_id,
      workspaceId,
      type: "assurance_decision",
      title: "Decision recorded for your outcome",
      message: `${outcome.title}: ${value.selectedOption}`,
      action_url: `/outcomes#outcome-${outcome.id}`,
      source_key: `assurance:decision:${rows[0].id}:${outcome.owner_id}`,
      metadata: { goalId: outcome.id, decisionId: rows[0].id },
      mirrorToChat: false,
      broadcastToSlack: false,
    }).catch(() => null);
  }
  queueRefresh({ workspaceId, sourceId: rows[0].id, change: "decision_recorded", database });
  return rows[0];
}

export async function reviewAssuranceDecision({ id, workspaceId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertManager(role);
  const decisionId = uuidValue(id, "Decision");
  const { rows } = await database.query(
    `SELECT d.* FROM assurance_decisions d
     WHERE d.workspace_id=$1 AND d.id=$2 LIMIT 1`,
    [workspaceId, decisionId]
  );
  const decision = rows[0];
  if (!decision) throw httpError("Decision not found", 404, "ASSURANCE_NOT_FOUND");
  await requireVisibleOutcome({ workspaceId, goalId: decision.goal_id, actorId, role, database, now });
  const effectiveness = String(input.effectiveness || "").toLowerCase();
  if (!EFFECTIVENESS.has(effectiveness)) throw httpError("Decision effectiveness is not supported");
  const observedResult = cleanText(input.observedResult ?? input.observed_result, 4000, { required: true, label: "Observed result" });
  const refs = evidenceRefs(input.evidenceRefs ?? input.evidence_refs);
  const inserted = await database.query(
    `INSERT INTO assurance_decision_reviews
       (workspace_id, decision_id, effectiveness, observed_result, evidence_refs, reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
    [workspaceId, decisionId, effectiveness, observedResult, JSON.stringify(refs), actorId, now.toISOString()]
  );
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.decision.review",
    entityType: "assurance_decision",
    entityId: decisionId,
    newValue: { reviewId: inserted.rows[0].id, effectiveness },
  });
  queueRefresh({ workspaceId, sourceId: decisionId, change: "decision_reviewed", database });
  return inserted.rows[0];
}

export function normalizeExperimentInput(input = {}, { defaultOwnerId = null } = {}) {
  const ownerId = input.ownerId ?? input.owner_id ?? defaultOwnerId;
  return {
    title: cleanText(input.title, 500, { required: true, label: "Experiment title" }),
    hypothesis: cleanText(input.hypothesis, 3000, { required: true, label: "Hypothesis" }),
    smallestTest: cleanText(input.smallestTest ?? input.smallest_test, 3000, { required: true, label: "Smallest test" }),
    successMeasure: cleanText(input.successMeasure ?? input.success_measure, 2000, { required: true, label: "Success measure" }),
    expectedInformation: cleanText(input.expectedInformation ?? input.expected_information, 2000, { label: "Expected information" }),
    ownerId: ownerId ? uuidValue(ownerId, "Owner") : null,
    dueDate: dateValue(input.dueDate ?? input.due_date, "Due date"),
  };
}

export async function createAssuranceExperiment({ workspaceId, goalId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertManager(role);
  const outcome = await requireVisibleOutcome({ workspaceId, goalId, actorId, role, database, now });
  const value = normalizeExperimentInput(input, { defaultOwnerId: outcome.owner_id });
  const startNow = input.startNow === true || input.start_now === true;
  if (value.ownerId) await assertActiveWorkspaceUser(workspaceId, value.ownerId, database);
  const { rows } = await database.query(
    `INSERT INTO assurance_experiments (
       workspace_id, goal_id, title, hypothesis, smallest_test, success_measure,
       expected_information, owner_id, due_date, created_by, status, started_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [workspaceId, outcome.id, value.title, value.hypothesis, value.smallestTest, value.successMeasure, value.expectedInformation, value.ownerId, value.dueDate, actorId, startNow ? "active" : "planned", startNow ? now.toISOString() : null]
  );
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.experiment.create",
    entityType: "assurance_experiment",
    entityId: rows[0].id,
    newValue: { goalId: outcome.id, title: value.title, ownerId: value.ownerId, dueDate: value.dueDate, status: startNow ? "active" : "planned" },
  });
  queueRefresh({ workspaceId, sourceId: rows[0].id, change: "experiment_created", database });
  return rows[0];
}

const ALLOWED_EXPERIMENT_TRANSITIONS = Object.freeze({
  planned: new Set(["planned", "active", "completed", "cancelled"]),
  active: new Set(["active", "completed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
});

export async function updateAssuranceExperiment({ id, workspaceId, actorId, role, input = {}, database = pool, now = new Date() }) {
  const experimentId = uuidValue(id, "Experiment");
  const { rows } = await database.query(
    `SELECT e.* FROM assurance_experiments e WHERE e.workspace_id=$1 AND e.id=$2 LIMIT 1`,
    [workspaceId, experimentId]
  );
  const current = rows[0];
  if (!current) throw httpError("Experiment not found", 404, "ASSURANCE_NOT_FOUND");
  await requireVisibleOutcome({ workspaceId, goalId: current.goal_id, actorId, role, database, now });
  if (!MANAGER_ROLES.has(normalizedRole(role)) && String(current.owner_id) !== String(actorId)) {
    throw httpError("You can update only experiments assigned to you", 403, "ASSURANCE_FORBIDDEN");
  }
  if (current.status === "completed" || current.status === "cancelled") {
    throw httpError("A completed or cancelled experiment is an immutable historical record", 409, "ASSURANCE_INVALID_TRANSITION");
  }
  const status = String(input.status ?? current.status).toLowerCase();
  if (!EXPERIMENT_STATUSES.has(status) || !ALLOWED_EXPERIMENT_TRANSITIONS[current.status]?.has(status)) {
    throw httpError("Experiment status transition is not allowed", 409, "ASSURANCE_INVALID_TRANSITION");
  }
  const resultStatus = String(input.resultStatus ?? input.result_status ?? current.result_status).toLowerCase();
  if (!EXPERIMENT_RESULTS.has(resultStatus)) throw httpError("Experiment result is not supported");
  const observedResult = cleanText(input.observedResult ?? input.observed_result ?? current.observed_result, 4000, { required: status === "completed", label: "Observed result" });
  if (status === "completed" && resultStatus === "not_recorded") {
    throw httpError("Choose whether the experiment supported, refuted, or could not resolve the hypothesis");
  }
  const refs = Object.prototype.hasOwnProperty.call(input, "evidenceRefs") || Object.prototype.hasOwnProperty.call(input, "evidence_refs")
    ? evidenceRefs(input.evidenceRefs ?? input.evidence_refs)
    : (current.evidence_refs || []);
  const updated = await database.query(
    `UPDATE assurance_experiments SET
       status=$1, result_status=$2, observed_result=$3, evidence_refs=$4::jsonb,
       started_at=CASE WHEN $1='active' AND started_at IS NULL THEN $5 ELSE started_at END,
       completed_at=CASE WHEN $1='completed' AND completed_at IS NULL THEN $5 ELSE completed_at END,
       updated_at=$5
     WHERE workspace_id=$6 AND id=$7 RETURNING *`,
    [status, resultStatus, observedResult, JSON.stringify(refs), now.toISOString(), workspaceId, experimentId]
  );
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.experiment.update",
    entityType: "assurance_experiment",
    entityId: experimentId,
    oldValue: { status: current.status, resultStatus: current.result_status },
    newValue: { status, resultStatus },
  });
  queueRefresh({ workspaceId, sourceId: experimentId, change: "experiment_updated", database });
  return updated.rows[0];
}

function addUtcDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildDecisionLabRecommendation(commitment, { unreviewedDecisions = 0, activeExperiments = 0, now = new Date() } = {}) {
  const assurance = commitment?.assurance || {};
  const counts = assurance.counts || {};
  const common = {
    outcomeId: commitment?.id || null,
    evidenceState: assurance.evidenceStatus || "insufficient_evidence",
    generatedBy: "deterministic_decision_lab_v1",
    guardrail: "One evidence-bounded next action is shown. No autonomous policy or work change is made.",
  };
  if (assurance.state === "verified" && unreviewedDecisions > 0) {
    return { ...common, action: "review_decision", label: "Review the decision result", why: `${unreviewedDecisions} recorded decision(s) do not yet have an observed result.`, confidence: "high", experimentDraft: null };
  }
  if (assurance.state === "verified") return { ...common, action: null, label: "No intervention needed", why: "The outcome is verified and no decision review is due.", confidence: "high", experimentDraft: null };
  if (assurance.state === "insufficient_evidence") return { ...common, action: "connect_work", label: "Connect one execution source", why: assurance.explanation, confidence: "high", experimentDraft: null };
  if (assurance.state === "needs_evidence") return { ...common, action: "add_evidence", label: "Verify the observed result", why: assurance.explanation, confidence: "high", experimentDraft: null };
  if (Number(counts.blockedDependencies) > 0) return { ...common, action: "review_dependency", label: "Resolve the predecessor decision", why: assurance.explanation, confidence: "high", experimentDraft: null };
  if (activeExperiments > 0) return { ...common, action: "review_experiment", label: "Complete the active validation", why: "An experiment is already reducing the largest recorded uncertainty; adding another would create noise.", confidence: "high", experimentDraft: null };
  if (Number(counts.blockedTasks) > 0 || Number(counts.overdueTasks) > 0 || assurance.state === "at_risk" || assurance.state === "off_track") {
    return {
      ...common,
      action: "run_small_experiment",
      label: "Run the smallest reversible test",
      why: assurance.explanation,
      confidence: assurance.evidenceStatus === "observed" ? "medium" : "low",
      experimentDraft: {
        title: `Validate the largest uncertainty for ${commitment.title}`.slice(0, 500),
        hypothesis: `A focused validation will reveal whether the current delivery approach can still satisfy: ${commitment.success_measure}`.slice(0, 3000),
        smallestTest: "Run a time-boxed validation against the highest-risk assumption before committing more capacity.",
        successMeasure: "The validation produces observable evidence that supports, refutes, or leaves the assumption inconclusive.",
        expectedInformation: "Whether to continue, change scope, or revise the delivery commitment.",
        ownerId: commitment.owner_id,
        dueDate: addUtcDays(now, 2),
      },
    };
  }
  return { ...common, action: null, label: "No intervention needed", why: "Connected work is progressing without a material exception.", confidence: "medium", experimentDraft: null };
}

export async function getDecisionLab({ workspaceId, goalId, actorId, role, database = pool, now = new Date() }) {
  assertManager(role);
  const outcome = await requireVisibleOutcome({ workspaceId, goalId, actorId, role, database, now });
  const { rows } = await database.query(
    `SELECT
       (SELECT COUNT(*)::int FROM assurance_decisions d
        WHERE d.workspace_id=$1 AND d.goal_id=$2 AND d.status='decided'
          AND NOT EXISTS (SELECT 1 FROM assurance_decision_reviews r WHERE r.workspace_id=d.workspace_id AND r.decision_id=d.id)) AS unreviewed_decisions,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND e.goal_id=$2 AND e.status IN ('planned','active')) AS active_experiments`,
    [workspaceId, outcome.id]
  );
  return {
    generatedAt: now.toISOString(),
    outcome: { id: outcome.id, title: outcome.title, state: outcome.assurance?.state },
    recommendation: buildDecisionLabRecommendation(outcome, {
      unreviewedDecisions: Number(rows[0]?.unreviewed_decisions) || 0,
      activeExperiments: Number(rows[0]?.active_experiments) || 0,
      now,
    }),
  };
}

export function normalizeScenarioInput(input = {}) {
  return {
    name: cleanText(input.name, 200, { required: true, label: "Scenario name" }),
    capacityDeltaPercent: Math.round(boundedNumber(input.capacityDeltaPercent ?? input.capacity_delta_percent, 0, -50, 100, "Capacity change")),
    targetDateShiftDays: Math.round(boundedNumber(input.targetDateShiftDays ?? input.target_date_shift_days, 0, -30, 180, "Target-date change")),
    resolveBlockedItems: Math.round(boundedNumber(input.resolveBlockedItems ?? input.resolve_blocked_items, 0, 0, 1000, "Resolved blockers")),
    scopeReductionPercent: Math.round(boundedNumber(input.scopeReductionPercent ?? input.scope_reduction_percent, 0, 0, 50, "Scope reduction")),
    runValidationExperiment: Boolean(input.runValidationExperiment ?? input.run_validation_experiment),
  };
}

export function calculateScenarioProjection(commitment, input, { verifiedSampleSize = 0, requiredSampleSize = 3 } = {}) {
  const value = normalizeScenarioInput(input);
  const assurance = commitment?.assurance || {};
  const counts = assurance.counts || {};
  const hasEvidence = assurance.evidenceStatus === "observed";
  const baselineBlockers = Number(counts.blockedTasks || 0) + Number(counts.blockedDependencies || 0);
  const resolved = Math.min(baselineBlockers, value.resolveBlockedItems);
  const materialChanges = [];
  if (value.capacityDeltaPercent) materialChanges.push(`${value.capacityDeltaPercent > 0 ? "+" : ""}${value.capacityDeltaPercent}% capacity`);
  if (value.targetDateShiftDays) materialChanges.push(`${value.targetDateShiftDays > 0 ? "+" : ""}${value.targetDateShiftDays} target-date days`);
  if (resolved) materialChanges.push(`${resolved} known blocker${resolved === 1 ? "" : "s"} resolved`);
  if (value.scopeReductionPercent) materialChanges.push(`${value.scopeReductionPercent}% scope reduction`);
  if (value.runValidationExperiment) materialChanges.push("one reversible validation experiment");
  const positiveSignals = Number(value.capacityDeltaPercent > 0) + Number(value.targetDateShiftDays > 0) + Number(resolved > 0) + Number(value.scopeReductionPercent > 0);
  const negativeSignals = Number(value.capacityDeltaPercent < 0) + Number(value.targetDateShiftDays < 0);
  const direction = !hasEvidence ? "unknown" : positiveSignals > negativeSignals ? "improved" : negativeSignals > positiveSignals ? "worsened" : "unchanged";
  // Historical outcome volume is not scenario calibration. Until proposed
  // changes are linked to later verified results, confidence must remain low.
  const confidenceLabel = hasEvidence ? "low" : "none";
  return {
    evidenceStatus: hasEvidence ? "modeled" : "insufficient_evidence",
    confidenceLabel,
    direction,
    baseline: {
      state: assurance.state || "insufficient_evidence",
      explanation: assurance.explanation || "No execution evidence is available.",
      remainingDays: assurance.remainingDays ?? null,
      knownBlockers: baselineBlockers,
      overdueTasks: Number(counts.overdueTasks || 0),
      taskProgress: assurance.taskProgress ?? null,
    },
    proposed: {
      knownBlockers: Math.max(0, baselineBlockers - resolved),
      materialChanges,
      uncertaintyReduced: value.runValidationExperiment,
    },
    remainingRisks: [
      Math.max(0, baselineBlockers - resolved) > 0 && `${Math.max(0, baselineBlockers - resolved)} known blocker(s) remain`,
      Number(counts.overdueTasks || 0) > 0 && `${Number(counts.overdueTasks)} overdue task(s) remain`,
      !commitment?.primary_project_id && "No project is connected",
    ].filter(Boolean),
    assumptions: [
      value.capacityDeltaPercent !== 0 && "Capacity changes are assumed to affect available effort; coordination cost is not known.",
      value.scopeReductionPercent > 0 && "Reduced scope is assumed to preserve the recorded success measure.",
      value.targetDateShiftDays !== 0 && "The proposed date change is assumed not to breach an external commitment.",
    ].filter(Boolean),
    unknowns: [
      "This directional comparison does not prove causation or predict a delivery probability.",
      confidenceLabel === "low" && `${Number(verifiedSampleSize) || 0} verified outcome(s) are available (learning gate: ${Math.max(3, Number(requiredSampleSize) || 3)}), but scenario confidence is not calibrated from them.`,
    ].filter(Boolean),
    modelVersion: "decision_scenario_v1",
    guardrail: "This is decision support, not a canonical workspace score. No work or policy is changed automatically.",
  };
}

export async function analyzeAssuranceScenario({ workspaceId, goalId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertManager(role);
  const outcome = await requireVisibleOutcome({ workspaceId, goalId, actorId, role, database, now });
  const normalized = normalizeScenarioInput(input);
  const { rows } = await database.query(
    `SELECT
       COALESCE((SELECT minimum_pattern_sample FROM assurance_workspace_policies WHERE workspace_id=$1), 3)::int AS required_sample_size,
       (SELECT COUNT(*)::int FROM assurance_outcome_observations WHERE workspace_id=$1) AS verified_sample_size`,
    [workspaceId]
  );
  const result = calculateScenarioProjection(outcome, normalized, {
    verifiedSampleSize: rows[0]?.verified_sample_size,
    requiredSampleSize: rows[0]?.required_sample_size,
  });
  const inserted = await database.query(
    `INSERT INTO assurance_scenario_analyses
       (workspace_id, goal_id, name, input, result, evidence_status, confidence_label, model_version, created_by, created_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10) RETURNING *`,
    [workspaceId, outcome.id, normalized.name, JSON.stringify(normalized), JSON.stringify(result), result.evidenceStatus, result.confidenceLabel, result.modelVersion, actorId, now.toISOString()]
  );
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.scenario.analyze",
    entityType: "assurance_scenario",
    entityId: inserted.rows[0].id,
    newValue: { goalId: outcome.id, direction: result.direction, evidenceStatus: result.evidenceStatus },
  });
  return inserted.rows[0];
}

export async function getDecisionOutcomeRecord({ workspaceId, goalId, actorId, role, database = pool, now = new Date() }) {
  const outcome = await requireVisibleOutcome({ workspaceId, goalId, actorId, role, database, now });
  const [decisions, experiments, scenarios, receipts, approvals] = await Promise.all([
    database.query(
      `SELECT d.*, recorder.username AS recorded_by_name,
              review.id AS latest_review_id, review.effectiveness AS latest_effectiveness,
              review.observed_result AS latest_observed_result, review.reviewed_at AS latest_reviewed_at,
              reviewer.username AS latest_reviewed_by_name
       FROM assurance_decisions d
       LEFT JOIN users recorder ON recorder.workspace_id=d.workspace_id AND recorder.id=d.recorded_by
       LEFT JOIN LATERAL (
         SELECT r.* FROM assurance_decision_reviews r
         WHERE r.workspace_id=d.workspace_id AND r.decision_id=d.id
         ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1
       ) review ON TRUE
       LEFT JOIN users reviewer ON reviewer.workspace_id=d.workspace_id AND reviewer.id=review.reviewed_by
       WHERE d.workspace_id=$1 AND d.goal_id=$2
       ORDER BY d.decided_at DESC`,
      [workspaceId, outcome.id]
    ).then((result) => result.rows),
    database.query(
      `SELECT e.*, owner.username AS owner_name, creator.username AS created_by_name
       FROM assurance_experiments e
       LEFT JOIN users owner ON owner.workspace_id=e.workspace_id AND owner.id=e.owner_id
       LEFT JOIN users creator ON creator.workspace_id=e.workspace_id AND creator.id=e.created_by
       WHERE e.workspace_id=$1 AND e.goal_id=$2
       ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, e.created_at DESC`,
      [workspaceId, outcome.id]
    ).then((result) => result.rows),
    database.query(
      `SELECT id, name, input, result, evidence_status, confidence_label, model_version, created_at
       FROM assurance_scenario_analyses WHERE workspace_id=$1 AND goal_id=$2
       ORDER BY created_at DESC LIMIT 20`,
      [workspaceId, outcome.id]
    ).then((result) => result.rows),
    database.query(
      `SELECT id, version, schema_version, sha256, redaction, generated_at
       FROM assurance_outcome_receipts WHERE workspace_id=$1 AND goal_id=$2
       ORDER BY version DESC LIMIT 20`,
      [workspaceId, outcome.id]
    ).then((result) => result.rows),
    database.query(
      `SELECT ar.id, ar.action_type, ar.status, ar.decision_note, ar.requested_at, ar.decided_at,
              requester.username AS requested_by_name, decider.username AS decided_by_name
       FROM assurance_approval_requests ar
       LEFT JOIN users requester ON requester.workspace_id=ar.workspace_id AND requester.id=ar.requested_by
       LEFT JOIN users decider ON decider.workspace_id=ar.workspace_id AND decider.id=ar.decided_by
       WHERE ar.workspace_id=$1 AND ar.goal_id=$2 ORDER BY ar.requested_at DESC`,
      [workspaceId, outcome.id]
    ).then((result) => result.rows),
  ]);
  return { outcome, decisions, experiments, scenarios, receipts, approvals };
}

export async function getDecisionOperatingInbox({ workspaceId, userId, role, database = pool, now = new Date() }) {
  const overview = await getAssuranceOverview({ workspaceId, userId, role, database, now });
  const goalIds = overview.commitments.map((item) => item.id);
  if (!goalIds.length) return { decisionsNeedingReview: [], experimentsNeedingAttention: [] };
  const [decisions, experiments] = await Promise.all([
    database.query(
      `SELECT d.id, d.goal_id, d.question, d.selected_option, d.review_due_at, o.title AS goal_title
       FROM assurance_decisions d
       JOIN okr_objectives o ON o.workspace_id=d.workspace_id AND o.id=d.goal_id
       WHERE d.workspace_id=$1 AND d.goal_id=ANY($2::uuid[]) AND d.status='decided'
         AND $4::text!='user'
         AND d.review_due_at IS NOT NULL AND d.review_due_at <= $3::date
         AND NOT EXISTS (
           SELECT 1 FROM assurance_decision_reviews r
           WHERE r.workspace_id=d.workspace_id AND r.decision_id=d.id
         )
       ORDER BY d.review_due_at ASC, d.decided_at ASC`,
      [workspaceId, goalIds, now.toISOString(), normalizedRole(role)]
    ).then((result) => result.rows),
    database.query(
      `SELECT e.id, e.goal_id, e.title, e.status, e.due_date, o.title AS goal_title
       FROM assurance_experiments e
       JOIN okr_objectives o ON o.workspace_id=e.workspace_id AND o.id=e.goal_id
       WHERE e.workspace_id=$1 AND e.goal_id=ANY($2::uuid[]) AND e.status IN ('planned','active')
         AND e.due_date IS NOT NULL AND e.due_date <= $3::date
         AND ($4::text!='user' OR e.owner_id=$5)
       ORDER BY e.due_date ASC, e.created_at ASC`,
      [workspaceId, goalIds, now.toISOString(), normalizedRole(role), userId]
    ).then((result) => result.rows),
  ]);
  return { decisionsNeedingReview: decisions, experimentsNeedingAttention: experiments };
}

export async function getDecisionOutcomeIntelligence({ workspaceId, goalIds = null, role = "admin", database = pool, requiredSampleSize = 3 }) {
  const scopedIds = Array.isArray(goalIds) ? goalIds : null;
  if (scopedIds && scopedIds.length === 0) {
    return {
      decisions: { total: 0, reviewed: 0, unreviewed: 0, effective: 0, mixed: 0, ineffective: 0, inconclusive: 0, effectivenessStatus: "learning", effectiveRate: null },
      experiments: { total: 0, active: 0, completed: 0, supported: 0, refuted: 0, inconclusive: 0 },
      scenarioAnalyses: 0,
      receiptsIssued: 0,
      policyProposals: normalizedRole(role) === "admin" ? [] : null,
      requiredSampleSize: Math.max(3, Number(requiredSampleSize) || 3),
    };
  }
  const ids = scopedIds || [];
  const aggregate = await database.query(
    `WITH latest_reviews AS (
       SELECT DISTINCT ON (r.decision_id) r.*
       FROM assurance_decision_reviews r
       WHERE r.workspace_id=$1
       ORDER BY r.decision_id, r.reviewed_at DESC, r.id DESC
     )
     SELECT
       (SELECT COUNT(*)::int FROM assurance_decisions d
        WHERE d.workspace_id=$1 AND ($2::boolean=FALSE OR d.goal_id=ANY($3::uuid[]))) AS decision_total,
       (SELECT COUNT(DISTINCT d.id)::int FROM assurance_decisions d
        JOIN latest_reviews r ON r.workspace_id=d.workspace_id AND r.decision_id=d.id
        WHERE d.workspace_id=$1 AND ($2::boolean=FALSE OR d.goal_id=ANY($3::uuid[]))) AS decision_reviewed,
       (SELECT COUNT(*)::int FROM latest_reviews r JOIN assurance_decisions d ON d.workspace_id=r.workspace_id AND d.id=r.decision_id
        WHERE r.workspace_id=$1 AND r.effectiveness='effective' AND ($2::boolean=FALSE OR d.goal_id=ANY($3::uuid[]))) AS decision_effective,
       (SELECT COUNT(*)::int FROM latest_reviews r JOIN assurance_decisions d ON d.workspace_id=r.workspace_id AND d.id=r.decision_id
        WHERE r.workspace_id=$1 AND r.effectiveness='mixed' AND ($2::boolean=FALSE OR d.goal_id=ANY($3::uuid[]))) AS decision_mixed,
       (SELECT COUNT(*)::int FROM latest_reviews r JOIN assurance_decisions d ON d.workspace_id=r.workspace_id AND d.id=r.decision_id
        WHERE r.workspace_id=$1 AND r.effectiveness='ineffective' AND ($2::boolean=FALSE OR d.goal_id=ANY($3::uuid[]))) AS decision_ineffective,
       (SELECT COUNT(*)::int FROM latest_reviews r JOIN assurance_decisions d ON d.workspace_id=r.workspace_id AND d.id=r.decision_id
        WHERE r.workspace_id=$1 AND r.effectiveness='inconclusive' AND ($2::boolean=FALSE OR d.goal_id=ANY($3::uuid[]))) AS decision_inconclusive,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND ($2::boolean=FALSE OR e.goal_id=ANY($3::uuid[]))) AS experiment_total,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND e.status IN ('planned','active') AND ($2::boolean=FALSE OR e.goal_id=ANY($3::uuid[]))) AS experiment_active,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND e.status='completed' AND ($2::boolean=FALSE OR e.goal_id=ANY($3::uuid[]))) AS experiment_completed,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND e.result_status='supported' AND ($2::boolean=FALSE OR e.goal_id=ANY($3::uuid[]))) AS experiment_supported,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND e.result_status='refuted' AND ($2::boolean=FALSE OR e.goal_id=ANY($3::uuid[]))) AS experiment_refuted,
       (SELECT COUNT(*)::int FROM assurance_experiments e
        WHERE e.workspace_id=$1 AND e.result_status='inconclusive' AND ($2::boolean=FALSE OR e.goal_id=ANY($3::uuid[]))) AS experiment_inconclusive,
       (SELECT COUNT(*)::int FROM assurance_scenario_analyses s
        WHERE s.workspace_id=$1 AND ($2::boolean=FALSE OR s.goal_id=ANY($3::uuid[]))) AS scenario_count,
       (SELECT COUNT(*)::int FROM assurance_outcome_receipts receipt
        WHERE receipt.workspace_id=$1 AND ($2::boolean=FALSE OR receipt.goal_id=ANY($3::uuid[]))) AS receipt_count`,
    [workspaceId, Boolean(scopedIds), ids]
  );
  const row = aggregate.rows[0] || {};
  const total = Number(row.decision_total) || 0;
  const reviewed = Number(row.decision_reviewed) || 0;
  const effective = Number(row.decision_effective) || 0;
  const mixed = Number(row.decision_mixed) || 0;
  const minimum = Math.max(3, Number(requiredSampleSize) || 3);
  const effectiveRate = reviewed >= minimum ? Math.round(((effective + mixed * 0.5) / reviewed) * 100) : null;
  const proposals = normalizedRole(role) === "admin"
    ? await database.query(
      `SELECT id, policy_key, current_value, proposed_value, rationale, evidence,
              sample_size, confounded, status, generated_at, review_note, reviewed_at, applied_at
       FROM assurance_policy_proposals WHERE workspace_id=$1 ORDER BY generated_at DESC LIMIT 20`,
      [workspaceId]
    ).then((result) => result.rows)
    : null;
  return {
    decisions: {
      total,
      reviewed,
      unreviewed: Math.max(0, total - reviewed),
      effective,
      mixed,
      ineffective: Number(row.decision_ineffective) || 0,
      inconclusive: Number(row.decision_inconclusive) || 0,
      effectivenessStatus: reviewed >= minimum ? "measured" : "learning",
      effectiveRate,
      interpretation: "Observed decision outcomes only; effectiveness labels do not prove causation.",
    },
    experiments: {
      total: Number(row.experiment_total) || 0,
      active: Number(row.experiment_active) || 0,
      completed: Number(row.experiment_completed) || 0,
      supported: Number(row.experiment_supported) || 0,
      refuted: Number(row.experiment_refuted) || 0,
      inconclusive: Number(row.experiment_inconclusive) || 0,
    },
    scenarioAnalyses: Number(row.scenario_count) || 0,
    receiptsIssued: Number(row.receipt_count) || 0,
    policyProposals: proposals,
    requiredSampleSize: minimum,
  };
}

export async function refreshAdaptivePolicyProposals({ workspaceId, actorId = null, role = "admin", database = pool, now = new Date(), system = false }) {
  if (!system) assertAdmin(role);
  const { rows } = await database.query(
    `SELECT
       COALESCE((SELECT risk_window_days FROM assurance_workspace_policies WHERE workspace_id=$1), 14)::int AS risk_window_days,
       COALESCE((SELECT minimum_pattern_sample FROM assurance_workspace_policies WHERE workspace_id=$1), 3)::int AS minimum_sample,
       COUNT(*) FILTER (WHERE on_time IS NOT NULL)::int AS sample_size,
       COUNT(*) FILTER (WHERE on_time IS TRUE)::int AS on_time_count,
       COUNT(*) FILTER (WHERE on_time IS FALSE)::int AS late_count,
       COUNT(*) FILTER (WHERE pre_completion_state IN ('at_risk','off_track'))::int AS prior_attention_count
     FROM assurance_outcome_observations WHERE workspace_id=$1`,
    [workspaceId]
  );
  const evidence = rows[0] || {};
  const sampleSize = Number(evidence.sample_size) || 0;
  const minimum = Math.max(3, Number(evidence.minimum_sample) || 3);
  const currentRiskWindow = Number(evidence.risk_window_days) || 14;
  if (sampleSize < minimum) {
    return { status: "learning", sampleSize, requiredSampleSize: minimum, proposals: [] };
  }
  const onTimeRate = Math.round(((Number(evidence.on_time_count) || 0) / sampleSize) * 100);
  const lateRate = 100 - onTimeRate;
  let proposedRiskWindow = currentRiskWindow;
  let rationale = null;
  if (lateRate >= 40 && currentRiskWindow < 30) {
    proposedRiskWindow = Math.min(30, currentRiskWindow + 7);
    rationale = `${lateRate}% of ${sampleSize} verified outcomes missed their target date. Earlier review may expose recoverable risk sooner.`;
  } else if (onTimeRate >= 90 && sampleSize >= Math.max(10, minimum) && currentRiskWindow > 7) {
    proposedRiskWindow = Math.max(7, currentRiskWindow - 3);
    rationale = `${onTimeRate}% of ${sampleSize} verified outcomes were on time. A narrower review window may reduce unnecessary alerts.`;
  }
  if (proposedRiskWindow === currentRiskWindow) {
    const existing = await database.query(
      `SELECT * FROM assurance_policy_proposals WHERE workspace_id=$1 ORDER BY generated_at DESC LIMIT 20`,
      [workspaceId]
    );
    return { status: "stable", sampleSize, requiredSampleSize: minimum, proposals: existing.rows };
  }
  const proposalEvidence = {
    verifiedOutcomeCount: sampleSize,
    onTimeRate,
    lateRate,
    priorAttentionCount: Number(evidence.prior_attention_count) || 0,
    interpretation: "Observed association; the proposed alert-window change is not a causal claim.",
  };
  await database.query(
    `INSERT INTO assurance_policy_proposals
       (workspace_id, policy_key, current_value, proposed_value, rationale, evidence, sample_size, confounded, status, generated_at)
     VALUES ($1,'risk_window_days',$2::jsonb,$3::jsonb,$4,$5::jsonb,$6,TRUE,'candidate',$7)
     ON CONFLICT (workspace_id, policy_key) WHERE status='candidate' DO UPDATE SET
       current_value=EXCLUDED.current_value, proposed_value=EXCLUDED.proposed_value,
       rationale=EXCLUDED.rationale, evidence=EXCLUDED.evidence,
       sample_size=EXCLUDED.sample_size, confounded=EXCLUDED.confounded,
       generated_at=EXCLUDED.generated_at`,
    [workspaceId, JSON.stringify(currentRiskWindow), JSON.stringify(proposedRiskWindow), rationale, JSON.stringify(proposalEvidence), sampleSize, now.toISOString()]
  );
  const proposals = await database.query(
    `SELECT * FROM assurance_policy_proposals WHERE workspace_id=$1 ORDER BY generated_at DESC LIMIT 20`,
    [workspaceId]
  );
  if (actorId) {
    await logAudit({ workspaceId, userId: actorId, action: "assurance.policy_proposal.refresh", entityType: "workspace", entityId: workspaceId, newValue: { sampleSize, proposedRiskWindow } });
  }
  return { status: "candidate", sampleSize, requiredSampleSize: minimum, proposals: proposals.rows };
}

export async function listAdaptivePolicyProposals({ workspaceId, role, database = pool }) {
  assertAdmin(role);
  const [policyEvidence, proposals] = await Promise.all([
    database.query(
      `SELECT
         COALESCE((SELECT minimum_pattern_sample FROM assurance_workspace_policies WHERE workspace_id=$1), 3)::int AS required_sample_size,
         (SELECT COUNT(*)::int FROM assurance_outcome_observations WHERE workspace_id=$1) AS sample_size`,
      [workspaceId]
    ).then((result) => result.rows[0] || {}),
    database.query(
      `SELECT id, policy_key, current_value, proposed_value, rationale, evidence,
              sample_size, confounded, status, generated_at, review_note, reviewed_at, applied_at
       FROM assurance_policy_proposals WHERE workspace_id=$1 ORDER BY generated_at DESC LIMIT 20`,
      [workspaceId]
    ).then((result) => result.rows),
  ]);
  const sampleSize = Number(policyEvidence.sample_size) || 0;
  const requiredSampleSize = Math.max(3, Number(policyEvidence.required_sample_size) || 3);
  return {
    status: sampleSize < requiredSampleSize
      ? "learning"
      : proposals.some((item) => item.status === "candidate") ? "candidate" : "stable",
    sampleSize,
    requiredSampleSize,
    proposals,
  };
}

export async function reviewAdaptivePolicyProposal({ id, workspaceId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertAdmin(role);
  const proposalId = uuidValue(id, "Policy proposal");
  const decision = String(input.decision || "").toLowerCase();
  if (!["approved", "rejected"].includes(decision)) throw httpError("Decision must be approved or rejected");
  const note = cleanText(input.note, 2000, { label: "Review note" });
  const client = await database.connect();
  let proposal;
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT * FROM assurance_policy_proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, proposalId]
    );
    proposal = selected.rows[0];
    if (!proposal) throw httpError("Policy proposal not found", 404, "ASSURANCE_NOT_FOUND");
    if (proposal.status !== "candidate") throw httpError("This proposal has already been reviewed", 409, "ASSURANCE_ALREADY_DECIDED");
    if (decision === "approved" && proposal.confounded && input.acknowledgeObservationalEvidence !== true) {
      throw httpError("Acknowledge that this proposal is based on observational evidence before applying it");
    }
    if (decision === "approved") {
      if (proposal.policy_key !== "risk_window_days") throw httpError("Policy proposal target is not supported");
      const nextValue = Math.round(boundedNumber(proposal.proposed_value, null, 1, 90, "Proposed risk window"));
      await client.query(
        `INSERT INTO assurance_workspace_policies (workspace_id, risk_window_days, updated_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id) DO UPDATE SET
           risk_window_days=EXCLUDED.risk_window_days,
           version=assurance_workspace_policies.version + 1,
           updated_by=EXCLUDED.updated_by,
           updated_at=$4`,
        [workspaceId, nextValue, actorId, now.toISOString()]
      );
      await client.query(
        `UPDATE assurance_policy_proposals SET status='applied', reviewed_by=$1, review_note=$2,
           reviewed_at=$3, applied_at=$3 WHERE workspace_id=$4 AND id=$5`,
        [actorId, note, now.toISOString(), workspaceId, proposalId]
      );
    } else {
      await client.query(
        `UPDATE assurance_policy_proposals SET status='rejected', reviewed_by=$1, review_note=$2,
           reviewed_at=$3 WHERE workspace_id=$4 AND id=$5`,
        [actorId, note, now.toISOString(), workspaceId, proposalId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await logAudit({
    workspaceId,
    userId: actorId,
    action: `assurance.policy_proposal.${decision}`,
    entityType: "assurance_policy_proposal",
    entityId: proposalId,
    newValue: { decision, policyKey: proposal.policy_key, proposedValue: proposal.proposed_value },
  });
  queueRefresh({ workspaceId, sourceId: proposalId, change: "adaptive_policy_reviewed", database });
  return { id: proposalId, status: decision === "approved" ? "applied" : "rejected" };
}

function receiptRedaction(input = {}) {
  return {
    includePeople: input.includePeople === true,
    includeEvidenceNotes: input.includeEvidenceNotes === true,
    includeDecisionRationale: input.includeDecisionRationale !== false,
  };
}

function buildReceiptSnapshot({ workspaceId, outcomeDetail, operatingRecord, redaction, generatedAt }) {
  const commitment = outcomeDetail.commitment;
  const person = (value) => redaction.includePeople ? value || null : null;
  return {
    schemaVersion: 1,
    workspaceId,
    generatedAt,
    outcome: {
      id: commitment.id,
      title: commitment.title,
      successMeasure: commitment.success_measure,
      targetDate: commitment.target_date,
      priority: commitment.priority,
      project: commitment.project_name || null,
      owner: person(commitment.owner_name),
      state: commitment.assurance?.state || null,
      explanation: commitment.assurance?.explanation || null,
      evidenceStatus: commitment.assurance?.evidenceStatus || null,
    },
    evidence: (outcomeDetail.evidence || []).map((item) => ({
      id: item.id,
      type: item.evidence_type,
      label: item.label,
      note: redaction.includeEvidenceNotes ? item.note || null : null,
      sourceType: item.source_entity_type || null,
      sourceProvider: item.source_provider || null,
      recordedBy: person(item.recorded_by_name),
      recordedAt: item.recorded_at,
      provenance: item.provenance || {},
    })),
    decisions: (operatingRecord.decisions || []).map((item) => ({
      id: item.id,
      type: item.decision_type,
      question: item.question,
      selectedOption: item.selected_option,
      alternatives: item.alternatives || [],
      rationale: redaction.includeDecisionRationale ? item.rationale : null,
      expectedEffect: item.expected_effect,
      confidence: item.confidence,
      reversibility: item.reversibility,
      decidedBy: person(item.recorded_by_name),
      decidedAt: item.decided_at,
      review: item.latest_review_id ? {
        effectiveness: item.latest_effectiveness,
        observedResult: item.latest_observed_result,
        reviewedBy: person(item.latest_reviewed_by_name),
        reviewedAt: item.latest_reviewed_at,
      } : null,
    })),
    experiments: (operatingRecord.experiments || []).map((item) => ({
      id: item.id,
      title: item.title,
      hypothesis: item.hypothesis,
      smallestTest: item.smallest_test,
      successMeasure: item.success_measure,
      status: item.status,
      resultStatus: item.result_status,
      observedResult: item.observed_result,
      owner: person(item.owner_name),
      dueDate: item.due_date,
      completedAt: item.completed_at,
    })),
    approvals: (operatingRecord.approvals || []).map((item) => ({
      id: item.id,
      actionType: item.action_type,
      status: item.status,
      requestedBy: person(item.requested_by_name),
      decidedBy: person(item.decided_by_name),
      requestedAt: item.requested_at,
      decidedAt: item.decided_at,
    })),
    redaction,
    assurance: {
      statement: "This receipt preserves the recorded outcome, evidence, decisions, experiments, and approvals at generation time.",
      limitation: "It is an evidence receipt, not a legal certification or proof of causation.",
    },
  };
}

export async function generateOutcomeReceipt({ workspaceId, goalId, actorId, role, input = {}, database = pool, now = new Date() }) {
  assertManager(role);
  const outcomeDetail = await getAssuranceCommitmentDetail({ id: goalId, workspaceId, userId: actorId, role, database, now });
  const operatingRecord = await getDecisionOutcomeRecord({ workspaceId, goalId, actorId, role, database, now });
  const redaction = receiptRedaction(input);
  const generatedAt = now.toISOString();
  const snapshot = buildReceiptSnapshot({ workspaceId, outcomeDetail, operatingRecord, redaction, generatedAt });
  const sha256 = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  const client = await database.connect();
  let receipt;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM okr_objectives WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, goalId]);
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
       FROM assurance_outcome_receipts WHERE workspace_id=$1 AND goal_id=$2`,
      [workspaceId, goalId]
    );
    const version = Number(versionResult.rows[0]?.next_version) || 1;
    const inserted = await client.query(
      `INSERT INTO assurance_outcome_receipts
         (workspace_id, goal_id, version, schema_version, snapshot, sha256, redaction, requested_by, generated_at)
       VALUES ($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7,$8) RETURNING id, version, schema_version, sha256, redaction, generated_at`,
      [workspaceId, goalId, version, JSON.stringify(snapshot), sha256, JSON.stringify(redaction), actorId, generatedAt]
    );
    receipt = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await logAudit({
    workspaceId,
    userId: actorId,
    action: "assurance.receipt.generate",
    entityType: "assurance_receipt",
    entityId: receipt.id,
    newValue: { goalId, version: receipt.version, sha256, redaction },
  });
  queueRefresh({ workspaceId, sourceId: receipt.id, change: "receipt_generated", database });
  return receipt;
}

export async function getOutcomeReceipt({ id, workspaceId, actorId, role, database = pool, now = new Date() }) {
  assertManager(role);
  const receiptId = uuidValue(id, "Receipt");
  const { rows } = await database.query(
    `SELECT * FROM assurance_outcome_receipts WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
    [workspaceId, receiptId]
  );
  const receipt = rows[0];
  if (!receipt) throw httpError("Outcome receipt not found", 404, "ASSURANCE_NOT_FOUND");
  await requireVisibleOutcome({ workspaceId, goalId: receipt.goal_id, actorId, role, database, now });
  const content = JSON.stringify({
    manifest: {
      receiptId: receipt.id,
      workspaceId,
      outcomeId: receipt.goal_id,
      version: receipt.version,
      schemaVersion: receipt.schema_version,
      generatedAt: receipt.generated_at,
      digestAlgorithm: "SHA-256",
      digestScope: "snapshot",
      sha256: receipt.sha256,
    },
    snapshot: receipt.snapshot,
  }, null, 2);
  return {
    receipt,
    content,
    contentType: "application/json; charset=utf-8",
    filename: `outcome-receipt-v${receipt.version}-${String(receipt.goal_id).slice(0, 8)}.json`,
  };
}

export default {
  analyzeAssuranceScenario,
  buildDecisionLabRecommendation,
  calculateScenarioProjection,
  createAssuranceDecision,
  createAssuranceExperiment,
  generateOutcomeReceipt,
  getDecisionLab,
  getDecisionOperatingInbox,
  getDecisionOutcomeIntelligence,
  getDecisionOutcomeRecord,
  getOutcomeReceipt,
  listAdaptivePolicyProposals,
  refreshAdaptivePolicyProposals,
  reviewAdaptivePolicyProposal,
  reviewAssuranceDecision,
  updateAssuranceExperiment,
};
