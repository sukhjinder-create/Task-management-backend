// execution/actionlog.js
//
// EWIP V3 — Enterprise Action Log. An immutable, append-only, replayable record of
// EVERYTHING the platform does: every decision, approval, execution, workflow run,
// automation firing, policy match. Deterministic id (idempotent). This is the single
// audit spine the analytics + UI read from. Pure factory (persistence in stores.js).

import { deepFreeze, deterministicId, nowIso } from "./lib.js";

export const ACTION_TYPES = Object.freeze([
  "decision_created", "decision_transition", "approval_requested", "approval_decision",
  "execution", "verification", "workflow_run", "automation_fired", "policy_matched",
]);

export function actionLogEntry({ workspaceId, type, refId = null, actor = null, payload = {}, at } = {}) {
  const occurredAt = nowIso(at);
  return deepFreeze({
    actionId: deterministicId("act", [workspaceId, type, refId, occurredAt, actor?.id ?? actor ?? null]),
    eiVersion: "ewip-3",
    workspaceId: String(workspaceId),
    type,
    refId,
    actor,
    payload,
    occurredAt,
  });
}

export function validateActionLogEntry(a) {
  const errors = [];
  if (!a?.actionId) errors.push("missing_actionId");
  if (!ACTION_TYPES.includes(a?.type)) errors.push("invalid_type");
  if (!a?.workspaceId) errors.push("missing_workspaceId");
  return { ok: errors.length === 0, errors };
}
