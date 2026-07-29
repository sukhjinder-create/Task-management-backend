// execution/policy.js
//
// EWIP V3 — Policy Engine. Policies are configurable IF/THEN rules (e.g. IF risk > 80
// THEN escalate) that are versioned, audited, workspace-overridable, and respect the AI
// Studio lock hierarchy (reuses LOCK_LEVELS). Evaluation is deterministic and pure —
// it returns the matched actions; it never executes them (execution is the caller's job
// via the capability runtime).

import { deepFreeze, deterministicId, nowIso } from "./lib.js";
import { LOCK_LEVELS } from "../ai-platform/contract/common.js";

const OPS = {
  gt: (a, b) => Number(a) > Number(b), gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b), lte: (a, b) => Number(a) <= Number(b),
  eq: (a, b) => a === b, ne: (a, b) => a !== b,
};

export function createPolicy(f) {
  const { workspaceId = null, scope = "PLATFORM", key, when, then, version = 1, lockLevel = "workspace_customizable", enabled = true, provenance = {} } = f || {};
  if (!key || !when || !then) return null;
  return deepFreeze({
    policyId: deterministicId("pol", [scope, key, version]),
    scope,                                    // "PLATFORM" | workspaceId
    workspaceId: workspaceId ? String(workspaceId) : null,
    key: String(key),
    when,                                     // { field, op, value }
    then,                                     // { action: capabilityKey|"escalate"|..., params }
    version,
    lockLevel: LOCK_LEVELS.includes(lockLevel) ? lockLevel : "workspace_customizable",
    enabled: Boolean(enabled),
    createdAt: nowIso(),
    provenance: { engineVersion: "ewip-pol-1", ...provenance },
  });
}

export function validatePolicy(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["policy_must_be_object"] };
  if (!p.key) errors.push("missing_key");
  if (!p.when?.op || !(p.when.op in OPS)) errors.push("invalid_condition_op");
  if (!p.then?.action) errors.push("missing_action");
  if (!LOCK_LEVELS.includes(p.lockLevel)) errors.push("invalid_lock_level");
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve the effective policy set honoring the lock hierarchy: a workspace policy may
 * override a platform policy for the same key UNLESS the platform policy is
 * global_locked; a workspace_locked platform policy also cannot be overridden. Pure.
 */
export function resolveEffectivePolicies(platformPolicies = [], workspacePolicies = []) {
  const byKey = new Map();
  for (const p of platformPolicies) byKey.set(p.key, p);
  for (const w of workspacePolicies) {
    const base = byKey.get(w.key);
    if (base && (base.lockLevel === "global_locked" || base.lockLevel === "workspace_locked")) continue; // locked → no override
    byKey.set(w.key, w);
  }
  return [...byKey.values()].filter((p) => p.enabled).sort((a, b) => a.key.localeCompare(b.key));
}

/** Evaluate facts against a policy set → matched actions. Deterministic. */
export function evaluatePolicies(facts = {}, policies = []) {
  const matches = [];
  for (const p of policies.slice().sort((a, b) => a.policyId.localeCompare(b.policyId))) {
    const fn = OPS[p.when.op];
    if (fn && fn(facts[p.when.field], p.when.value)) {
      matches.push({ policyId: p.policyId, key: p.key, action: p.then.action, params: p.then.params || {}, version: p.version });
    }
  }
  return matches;
}
