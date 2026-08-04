// execution/decision.js
//
// EWIP V3 — Decision Engine. A Decision is a FIRST-CLASS entity that carries a
// recommendation through its lifecycle: recommendation → decision → approval →
// execution → verification → outcome. The decision "record" is immutable; its lifecycle
// is an APPEND-ONLY event stream (no mutable status column), and the current state is
// resolved from the latest event — so history is complete and replayable. Deterministic.
// Reuses the EI recommendation refs for full traceability.

import { deepFreeze, deterministicId, nowIso } from "./lib.js";

export const DECISION_STATES = Object.freeze(["created", "pending_approval", "approved", "rejected", "executing", "executed", "verified", "failed", "cancelled"]);

/** Build the immutable decision core from an EI recommendation. */
export function createDecisionFromRecommendation({ workspaceId, recommendation, proposedAction, now } = {}) {
  if (!workspaceId || !recommendation) return null;
  const createdAt = nowIso(now);
  return deepFreeze({
    decisionId: deterministicId("dec", [workspaceId, recommendation.recommendationId, createdAt]),
    eiVersion: "ewip-3",
    workspaceId: String(workspaceId),
    sourceRecommendationId: recommendation.recommendationId,
    entity: recommendation.entity || null,
    // The concrete action this decision would execute (a capability + input).
    proposedAction: proposedAction || null,   // { capabilityKey, input }
    rationaleRefs: {                           // inherited EI traceability
      predictionId: recommendation.rationaleRefs?.predictionId ?? null,
      reasoningTraceId: recommendation.rationaleRefs?.reasoningTraceId ?? null,
      evidenceIds: recommendation.rationaleRefs?.evidenceIds || [],
      attributionIds: recommendation.rationaleRefs?.attributionIds || [],
    },
    requiresApproval: recommendation.requiresApproval !== false,
    manualOnly: Boolean(recommendation.manualOnly),
    createdAt,
    provenance: { engineVersion: "ewip-dec-1", sourceStatus: recommendation.status ?? null },
  });
}

/**
 * Build a decision from an AI-AGENT proposal (a chat message the assistant read
 * as a request to act), rather than from an EI recommendation.
 *
 * Explainability is NOT relaxed for this origin. `validateDecision` requires a
 * source id and a reasoning trace, and both are satisfied with REAL evidence:
 *   • sourceRecommendationId → the chat message that triggered the proposal
 *   • reasoningTraceId       → the tool call (name + extracted arguments)
 * Anyone auditing an agent decision can therefore walk back to the exact message
 * a human wrote and the exact slots the model extracted from it.
 *
 * Everything agent-specific rides in `provenance`, which stores.js already
 * persists as provenance_json — so this needs NO migration and no new columns.
 *
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {object} p.trigger  { messageId, channelKey, text, userId, userRole, toolCall, model }
 * @param {object} p.proposedAction { capabilityKey, input }
 * @param {boolean} [p.requiresApproval]
 */
export function createDecisionFromAgent({ workspaceId, trigger, proposedAction, requiresApproval = true, now } = {}) {
  if (!workspaceId || !trigger?.messageId || !proposedAction?.capabilityKey) return null;
  const createdAt = nowIso(now);

  // Deterministic refs: the same trigger message + tool call always yields the
  // same ids, which makes agent proposals idempotent on retry.
  const sourceRecommendationId = deterministicId("agentsrc", [workspaceId, trigger.messageId]);
  const reasoningTraceId = deterministicId("agenttrace", [
    workspaceId, trigger.messageId, trigger.toolCall?.name ?? null, trigger.toolCall?.arguments ?? null,
  ]);

  return deepFreeze({
    decisionId: deterministicId("dec", [workspaceId, sourceRecommendationId, createdAt]),
    eiVersion: "ewip-3",
    workspaceId: String(workspaceId),
    sourceRecommendationId,
    entity: proposedAction.entity || null,
    proposedAction,
    rationaleRefs: {
      predictionId: null,
      reasoningTraceId,
      evidenceIds: [trigger.messageId],
      attributionIds: trigger.userId ? [String(trigger.userId)] : [],
    },
    requiresApproval: requiresApproval !== false,
    manualOnly: false,
    createdAt,
    provenance: {
      engineVersion: "ewip-dec-1",
      origin: "agent",
      agentVersion: "ai-task-1",
      // The return path: lets the pipeline post the outcome back where it started.
      channelKey: trigger.channelKey ?? null,
      triggerMessageId: trigger.messageId,
      triggerText: String(trigger.text ?? "").slice(0, 500),
      requestedBy: trigger.userId ? { id: String(trigger.userId), role: trigger.userRole ?? null } : null,
      toolCall: trigger.toolCall
        ? { name: trigger.toolCall.name, arguments: trigger.toolCall.arguments ?? {}, argumentsValid: trigger.toolCall.argumentsValid !== false }
        : null,
      model: trigger.model ?? null,
    },
  });
}

/** An append-only lifecycle event. Deterministic id. */
export function decisionEvent({ decisionId, workspaceId, from, to, actor = null, ref = null, at } = {}) {
  const occurredAt = nowIso(at);
  return deepFreeze({
    eventId: deterministicId("devt", [decisionId, from, to, occurredAt, actor?.id ?? actor ?? null, ref ?? null]),
    decisionId, workspaceId: String(workspaceId), from, to, actor, ref, occurredAt,
  });
}

/** Resolve current decision state from its event stream (latest wins). Pure. */
export function resolveDecisionState(decision, events = []) {
  const mine = events.filter((e) => e.decisionId === decision.decisionId)
    .slice().sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || String(a.eventId).localeCompare(String(b.eventId)));
  const status = mine.length ? mine[mine.length - 1].to : "created";
  return { decisionId: decision.decisionId, status, transitions: mine.length, history: mine };
}

/** Whether a transition is allowed (guards the lifecycle). Pure. */
export function canTransition(from, to) {
  const allowed = {
    created: ["pending_approval", "approved", "cancelled"],
    pending_approval: ["approved", "rejected", "cancelled"],
    approved: ["executing", "cancelled"],
    executing: ["executed", "failed"],
    executed: ["verified", "failed"],
    verified: [], failed: ["executing"], rejected: [], cancelled: [],
  };
  return (allowed[from] || []).includes(to);
}

export function validateDecision(d) {
  const errors = [];
  if (!d || typeof d !== "object") return { ok: false, errors: ["decision_must_be_object"] };
  if (!d.decisionId) errors.push("missing_decisionId");
  if (!d.sourceRecommendationId) errors.push("missing_source_recommendation");
  if (!d.rationaleRefs?.reasoningTraceId) errors.push("missing_reasoning_ref"); // stays explainable
  return { ok: errors.length === 0, errors };
}
