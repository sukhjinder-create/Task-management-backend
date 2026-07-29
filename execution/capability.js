// execution/capability.js
//
// EWIP V3 — Capability Runtime + Registry. Everything executable is a Capability with a
// contract-in-code (inputs/outputs/permission/version/rollback), mirroring the AI
// Platform capability model (reused pattern, NOT duplicated). Execution is capability-
// DRIVEN: the runtime dispatches by key through the registry — never hardcoded branch
// logic. The side-effects safety gate makes execution a deterministic DRY-RUN unless
// explicitly enabled. Every registered capability is really wired to a live service
// (see adapters.js); the catalog is extended by adding a contract + an adapter.

import { deepFreeze, deterministicId, validateShape, nowIso } from "./lib.js";
import { areSideEffectsEnabled } from "./config.js";
import { REAL_ADAPTERS } from "./adapters.js";

/** Contract-in-code catalog. Each entry is really wired to a product service. */
export const CAPABILITY_CATALOG = Object.freeze({
  "work.task.create": { key: "work.task.create", version: 1, title: "Create Task", permission: "manager", sideEffect: true, inputs: { title: { required: true, type: "string" }, projectId: { required: true }, priority: { type: "string" } }, output: "Task", rollback: "archive_task" },
  "work.task.assign": { key: "work.task.assign", version: 1, title: "Assign Task", permission: "manager", sideEffect: true, inputs: { taskId: { required: true }, assignedTo: { required: true } }, output: "Task", rollback: "reassign_previous" },
  "work.task.update": { key: "work.task.update", version: 1, title: "Update Task", permission: "manager", sideEffect: true, inputs: { taskId: { required: true }, changes: { required: true } }, output: "Task", rollback: "restore_previous" },
  "work.task.priority": { key: "work.task.priority", version: 1, title: "Change Priority", permission: "manager", sideEffect: true, inputs: { taskId: { required: true }, priority: { required: true, type: "string" } }, output: "Task", rollback: "restore_priority" },
  "work.team.notify": { key: "work.team.notify", version: 1, title: "Notify Team Member", permission: "member", sideEffect: true, inputs: { userId: { required: true }, message: { required: true, type: "string" } }, output: "Notification", rollback: "none" },
  "work.risk.escalate": { key: "work.risk.escalate", version: 1, title: "Escalate Risk", permission: "member", sideEffect: true, inputs: { userId: { required: true } }, output: "Notification", rollback: "none" },
});

export function listCapabilities() { return Object.values(CAPABILITY_CATALOG); }
export function getCapability(key) { return CAPABILITY_CATALOG[key] || null; }

export function validateCapabilityInput(key, input) {
  const cap = getCapability(key);
  if (!cap) return { ok: false, errors: ["unknown_capability"] };
  return validateShape(input, cap.inputs);
}

/**
 * Execute a capability by key. Deterministic id + record. Respects the side-effects
 * safety gate (dry-run when OFF). Adapter is looked up by key (injectable for tests).
 * @returns {Promise<object>} frozen execution record
 */
export async function executeCapability({ workspaceId, key, input = {}, context = {}, now } = {}, deps = {}) {
  const cap = getCapability(key);
  const startedAt = nowIso(now);
  const executionId = deterministicId("exec", [workspaceId, key, input, context.idempotencyKey ?? context.decisionId ?? startedAt]);
  const base = { executionId, eiVersion: "ewip-3", workspaceId: String(workspaceId), capabilityKey: key, capabilityVersion: cap?.version ?? null, startedAt };

  if (!cap) return deepFreeze({ ...base, ok: false, status: "failed", executed: false, simulated: false, failureReason: "unknown_capability", endedAt: startedAt });

  const v = validateCapabilityInput(key, input);
  if (!v.ok) return deepFreeze({ ...base, ok: false, status: "failed", executed: false, simulated: false, failureReason: "invalid_input", errors: v.errors, endedAt: startedAt });

  const sideEffectsOn = deps.areSideEffectsEnabled ? deps.areSideEffectsEnabled(workspaceId) : areSideEffectsEnabled(workspaceId);
  if (cap.sideEffect && !sideEffectsOn) {
    // Deterministic dry-run — no live mutation.
    return deepFreeze({ ...base, ok: true, status: "simulated", executed: false, simulated: true, output: { simulated: true, wouldCall: key, input }, endedAt: nowIso(now) });
  }

  const adapter = (deps.adapters && deps.adapters[key]) || REAL_ADAPTERS[key];
  if (typeof adapter !== "function") return deepFreeze({ ...base, ok: false, status: "failed", executed: false, simulated: false, failureReason: "adapter_not_wired", endedAt: startedAt });

  try {
    const output = await adapter({ input, context, workspaceId });
    const ok = output?.ok !== false;
    return deepFreeze({ ...base, ok, status: ok ? "executed" : "failed", executed: true, simulated: false, output, entity: output?.entity ?? null, endedAt: nowIso(now) });
  } catch (err) {
    return deepFreeze({ ...base, ok: false, status: "failed", executed: true, simulated: false, failureReason: String(err?.message || err), endedAt: nowIso(now) });
  }
}
