// execution/automation.js
//
// EWIP V3 — Automation Engine. Automations bind a TRIGGER (event / schedule / webhook /
// manual / conditional / recurring) to an ACTION (a capability or a workflow). Trigger
// matching is deterministic and pure; it returns the automations that should fire — it
// does not execute them (the caller runs the capability/workflow runtime, side-effect
// gated). Versioned + auditable.

import { deepFreeze, deterministicId, nowIso } from "./lib.js";

export const TRIGGER_TYPES = Object.freeze(["event", "schedule", "webhook", "manual", "conditional", "recurring"]);

export function createAutomation(f) {
  const { workspaceId, key, trigger, action, enabled = true, version = 1, provenance = {} } = f || {};
  if (!workspaceId || !key || !trigger?.type || !action) return null;
  return deepFreeze({
    automationId: deterministicId("auto", [workspaceId, key, version]),
    workspaceId: String(workspaceId),
    key: String(key),
    trigger,                                  // { type, event?, cron?, condition?, webhookKey? }
    action,                                   // { kind: "capability"|"workflow", ref, input? }
    enabled: Boolean(enabled),
    version,
    createdAt: nowIso(),
    provenance: { engineVersion: "ewip-auto-1", ...provenance },
  });
}

export function validateAutomation(a) {
  const errors = [];
  if (!a || typeof a !== "object") return { ok: false, errors: ["automation_must_be_object"] };
  if (!a.key) errors.push("missing_key");
  if (!TRIGGER_TYPES.includes(a.trigger?.type)) errors.push("invalid_trigger_type");
  if (!["capability", "workflow"].includes(a.action?.kind)) errors.push("invalid_action_kind");
  if (!a.action?.ref) errors.push("missing_action_ref");
  return { ok: errors.length === 0, errors };
}

function condOk(cond, facts) {
  if (!cond) return true;
  const l = facts?.[cond.field];
  switch (cond.op) { case "gt": return Number(l) > Number(cond.value); case "gte": return Number(l) >= Number(cond.value); case "lt": return Number(l) < Number(cond.value); case "lte": return Number(l) <= Number(cond.value); case "eq": return l === cond.value; case "ne": return l !== cond.value; default: return Boolean(l); }
}

/**
 * Match an incoming signal against automations. Deterministic.
 * @param {object} signal { type, event?, webhookKey?, facts? }
 * @param {Array} automations
 * @returns {Array} automations that fire (with the resolved action)
 */
export function matchTriggers(signal = {}, automations = []) {
  const fired = [];
  for (const a of automations.slice().sort((x, y) => x.automationId.localeCompare(y.automationId))) {
    if (!a.enabled || a.trigger.type !== signal.type) continue;
    let ok = false;
    switch (a.trigger.type) {
      case "event": ok = a.trigger.event === signal.event; break;
      case "webhook": ok = a.trigger.webhookKey === signal.webhookKey; break;
      case "conditional": ok = condOk(a.trigger.condition, signal.facts || {}); break;
      case "manual": ok = true; break;
      case "schedule": case "recurring": ok = a.trigger.cron === signal.cron; break;
      default: ok = false;
    }
    if (ok) fired.push({ automationId: a.automationId, key: a.key, action: a.action });
  }
  return fired;
}
