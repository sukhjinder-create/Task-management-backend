// execution/approval.js
//
// EWIP V3 — Approval Engine. Resolves an approval CHAIN for a decision (automatic /
// manager / admin / executive / custom), then tracks it as an APPEND-ONLY event stream
// (approve / reject / escalate / delegate / timeout). Current approval state is resolved
// deterministically from the events — full history + audit, no mutable status. Pure.

import { deepFreeze, deterministicId, nowIso } from "./lib.js";

export const APPROVAL_MODES = Object.freeze(["auto", "manager", "admin", "executive", "chain"]);
export const APPROVAL_ACTIONS = Object.freeze(["approve", "reject", "escalate", "delegate", "timeout"]);

const MODE_STEPS = {
  auto: [],
  manager: [{ role: "manager" }],
  admin: [{ role: "admin" }],
  executive: [{ role: "executive" }],
};

/** Build the required approval chain for a decision under a policy. Deterministic. */
export function resolveChain({ decision, policy = { mode: "manager" }, now } = {}) {
  const mode = APPROVAL_MODES.includes(policy.mode) ? policy.mode : "manager";
  const steps = (mode === "chain" ? (policy.steps || []) : MODE_STEPS[mode]).map((s, i) => ({ index: i, role: s.role || null, approverId: s.approverId || null }));
  const timeoutMs = Number(policy.timeoutMs) || 0;
  const createdAt = nowIso(now);
  return deepFreeze({
    approvalId: deterministicId("apr", [decision.decisionId, mode, steps]),
    decisionId: decision.decisionId,
    workspaceId: decision.workspaceId,
    mode,
    steps,
    autoApproved: mode === "auto",
    onTimeout: policy.onTimeout || "escalate", // escalate | reject | auto_approve
    timeoutAt: timeoutMs ? nowIso((now ?? Date.now()) + timeoutMs) : null,
    createdAt,
  });
}

export function approvalEvent({ approvalId, workspaceId, action, step = 0, actor = null, delegateTo = null, at } = {}) {
  const occurredAt = nowIso(at);
  return deepFreeze({
    eventId: deterministicId("aevt", [approvalId, action, step, occurredAt, actor?.id ?? actor ?? null, delegateTo?.id ?? delegateTo ?? null]),
    approvalId, workspaceId: String(workspaceId), action, step, actor, delegateTo, occurredAt,
  });
}

/** Resolve current approval state from its events. Deterministic. */
export function resolveApprovalState(request, events = []) {
  if (request.autoApproved || request.steps.length === 0) {
    return { approvalId: request.approvalId, status: "approved", currentStep: 0, totalSteps: 0, delegations: {}, history: [] };
  }
  const mine = events.filter((e) => e.approvalId === request.approvalId)
    .slice().sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || String(a.eventId).localeCompare(String(b.eventId)));

  let step = 0, status = "pending";
  const delegations = {};
  for (const e of mine) {
    if (status !== "pending") break;
    switch (e.action) {
      case "approve": if (e.step === step) { step += 1; if (step >= request.steps.length) status = "approved"; } break;
      case "reject": status = "rejected"; break;
      case "delegate": delegations[e.step] = e.delegateTo; break;
      case "escalate": status = "escalated"; break;
      case "timeout":
        if (request.onTimeout === "reject") status = "rejected";
        else if (request.onTimeout === "auto_approve") { step += 1; if (step >= request.steps.length) status = "approved"; }
        else status = "escalated";
        break;
      default: break;
    }
  }
  return { approvalId: request.approvalId, status, currentStep: step, totalSteps: request.steps.length, delegations, history: mine };
}

/** The next approver expectation (for an inbox), or null when resolved. Pure. */
export function pendingApprover(request, state) {
  if (!state || state.status !== "pending") return null;
  const step = request.steps[state.currentStep];
  if (!step) return null;
  return { step: state.currentStep, role: step.role, approverId: state.delegations[state.currentStep]?.id ?? step.approverId ?? null };
}
