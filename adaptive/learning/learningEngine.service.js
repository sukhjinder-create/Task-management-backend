import pool from "../../db.js";
import { refreshAdaptiveStrategyProfile, refreshRecommendationProfile } from "../personalization/personalizationEngine.service.js";

const FEEDBACK_SIGNALS = new Set([
  "recommendation.accepted",
  "recommendation.rejected",
  "recommendation.ignored",
  "recommendation.edited",
]);

const STRATEGY_SIGNALS = new Set([
  ...FEEDBACK_SIGNALS,
  "execution.succeeded",
  "execution.failed",
  "prediction.accuracy",
]);

async function refreshLearningProfiles({ workspaceId, scopeType, scopeId, signalKey }) {
  if (FEEDBACK_SIGNALS.has(signalKey)) {
    await refreshRecommendationProfile({ workspaceId, scopeType, scopeId });
    if (scopeType !== "workspace") {
      await refreshRecommendationProfile({ workspaceId, scopeType: "workspace", scopeId: null });
    }
  }
  if (STRATEGY_SIGNALS.has(signalKey)) {
    await refreshAdaptiveStrategyProfile({ workspaceId, scopeType, scopeId });
    if (scopeType !== "workspace") {
      await refreshAdaptiveStrategyProfile({ workspaceId, scopeType: "workspace", scopeId: null });
    }
  }
}

export async function recordLearningSignal({
  workspaceId,
  scopeType,
  scopeId = null,
  signalKey,
  signalValue = {},
  source,
  runtimeRunId = null,
  actionId = null,
  eventId = null,
  actorUserId = null,
  confidence = null,
  idempotencyKey = null,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_learning_signals (
      workspace_id, scope_type, scope_id, signal_key, signal_value, source,
      runtime_run_id, action_id, event_id, actor_user_id, confidence, idempotency_key
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING *
    `,
    [
      workspaceId, scopeType, scopeId, signalKey, JSON.stringify(signalValue || {}), source,
      runtimeRunId, actionId, eventId, actorUserId, confidence, idempotencyKey,
    ]
  );
  const signal = rows[0] || null;
  if (signal && STRATEGY_SIGNALS.has(signalKey)) {
    await refreshLearningProfiles({ workspaceId, scopeType, scopeId, signalKey });
  }
  return signal;
}

export async function reverseLearningSignal({ workspaceId, signalId, actorUserId, reason }) {
  const { rows } = await pool.query(
    `
    UPDATE adaptive_learning_signals
    SET status = 'reversed', reversed_at = NOW(), reversed_by = $1, reversal_reason = $2
    WHERE id = $3 AND workspace_id = $4 AND status = 'active'
    RETURNING *
    `,
    [actorUserId, reason || "Reversed by administrator", signalId, workspaceId]
  );
  const signal = rows[0] || null;
  if (signal && FEEDBACK_SIGNALS.has(signal.signal_key)) {
    await refreshRecommendationProfile({
      workspaceId,
      scopeType: signal.scope_type,
      scopeId: signal.scope_id,
    });
  }
  if (signal && STRATEGY_SIGNALS.has(signal.signal_key)) {
    await refreshAdaptiveStrategyProfile({
      workspaceId,
      scopeType: signal.scope_type,
      scopeId: signal.scope_id,
    });
  }
  return signal;
}

export async function recordActionDecisionLearning({ action, decision, actorUserId, notes = null, outcome = {} }) {
  if (!action || action.source !== "adaptive_runtime") return null;
  const signalKey = ({
    approved: "recommendation.accepted",
    executed: "execution.succeeded",
    rejected: "recommendation.rejected",
    ignored: "recommendation.ignored",
    edited: "recommendation.edited",
  })[decision];
  if (!signalKey) return null;

  const scopeType = action.target_user_id ? "user" : action.project_id ? "project" : "workspace";
  const scopeId = action.target_user_id || action.project_id || null;
  return recordLearningSignal({
    workspaceId: action.workspace_id,
    scopeType,
    scopeId,
    signalKey,
    signalValue: { decision, notes, outcome, capabilityKey: action.capability_key },
    source: "operations_action_decision",
    runtimeRunId: action.adaptive_runtime_run_id,
    actionId: action.id,
    actorUserId,
    confidence: action.confidence,
    idempotencyKey: `action:${action.id}:${decision}`,
  });
}

export async function listLearningSignals({ workspaceId, scopeType = null, scopeId = null, limit = 100 }) {
  const params = [workspaceId];
  const where = ["workspace_id = $1"];
  let index = 2;
  if (scopeType) { where.push(`scope_type = $${index++}`); params.push(scopeType); }
  if (scopeId) { where.push(`scope_id = $${index++}`); params.push(scopeId); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 250));
  const { rows } = await pool.query(
    `SELECT * FROM adaptive_learning_signals
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${index}`,
    params
  );
  return rows;
}
