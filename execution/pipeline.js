// execution/pipeline.js
//
// EWIP V3 — the closed execution pipeline that ties the engines together:
//   decision → approval → execution → verification → outcome.
// Deterministic and side-effect-safe (execution goes through the capability runtime,
// which dry-runs unless the side-effects gate is ON). It EMITS the append-only decision
// events + an execution + a verification; persistence is the caller's job (DI). Reuses
// the decision, approval, capability, and verification engines — no new logic duplicated.

import { executeCapability as realExecute } from "./capability.js";
import { verifyExecution } from "./verification.js";
import { decisionEvent } from "./decision.js";
import { resolveChain, resolveApprovalState } from "./approval.js";
import { nowIso } from "./lib.js";

/**
 * @param {object} p { workspaceId, decision, approvalPolicy?, approvalEvents?, actor?, now }
 * @param {object} [deps] { executeCapability }
 * @returns {Promise<object>} { stage, approval, approvalState, execution?, verification?, events }
 */
export async function runDecisionPipeline({ workspaceId, decision, approvalPolicy = { mode: "manager" }, approvalEvents = [], actor = null, now } = {}, deps = {}) {
  const execute = deps.executeCapability || realExecute;
  const approval = resolveChain({ decision, policy: approvalPolicy, now });
  const approvalState = resolveApprovalState(approval, approvalEvents);
  const events = [decisionEvent({ decisionId: decision.decisionId, workspaceId, from: "created", to: "pending_approval", actor, ref: approval.approvalId, at: now })];

  if (approvalState.status !== "approved") {
    return { stage: "awaiting_approval", approval, approvalState, events };
  }
  events.push(decisionEvent({ decisionId: decision.decisionId, workspaceId, from: "pending_approval", to: "approved", actor, ref: approval.approvalId, at: now }));

  if (!decision.proposedAction?.capabilityKey) {
    return { stage: "approved_no_action", approval, approvalState, events };
  }

  events.push(decisionEvent({ decisionId: decision.decisionId, workspaceId, from: "approved", to: "executing", actor, at: now }));
  const execution = await execute({ workspaceId, key: decision.proposedAction.capabilityKey, input: decision.proposedAction.input || {}, context: { decisionId: decision.decisionId, actorId: actor?.id ?? actor ?? null, idempotencyKey: decision.decisionId }, now });
  const verification = verifyExecution(execution, { entityType: decision.entity?.type });

  const ok = execution.ok && verification.verified;
  events.push(decisionEvent({ decisionId: decision.decisionId, workspaceId, from: "executing", to: ok ? "executed" : "failed", actor, ref: execution.executionId, at: now }));
  if (ok) events.push(decisionEvent({ decisionId: decision.decisionId, workspaceId, from: "executed", to: "verified", actor, ref: execution.executionId, at: now }));

  return { stage: ok ? "completed" : "failed", approval, approvalState, execution, verification, events, completedAt: nowIso(now) };
}
