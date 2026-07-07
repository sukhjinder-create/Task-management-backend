// ei/reasoning/service.js
//
// EI V2.1 Phase 4 — orchestration: group Phase-2 attributions by (effect entity,
// effect type) into claims and build one immutable reasoning trace per claim.
// Deterministic, replay-safe, flag-gated, additive (not wired to bus/endpoint).

import { buildTrace } from "./builder.js";
import { appendTrace } from "./store.js";
import { isEiReasoningEnabled } from "../config/flags.js";

/**
 * @param {{workspaceId:string, attributions:Array, evidence?:Array, now?:number}} args
 * @param {object} [deps] { appendTrace }
 */
export async function buildTracesForWorkspace({ workspaceId, attributions = [], evidence = [], now } = {}, deps = {}) {
  if (!isEiReasoningEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendTrace || appendTrace;

  // Group attributions by (effect entity, effect type) → one claim each.
  const groups = new Map();
  for (const a of attributions) {
    const ent = a.effect?.entity || { type: null, id: null };
    const key = `${a.effect?.type}::${ent.type}:${ent.id}`;
    if (!groups.has(key)) groups.set(key, { effectEntity: ent, effectType: a.effect?.type, attributions: [] });
    groups.get(key).attributions.push(a);
  }

  const traces = [];
  let written = 0;
  for (const g of [...groups.values()].sort((x, y) => `${x.effectType}${x.effectEntity.id}`.localeCompare(`${y.effectType}${y.effectEntity.id}`))) {
    const t = buildTrace({ workspaceId, effectEntity: g.effectEntity, effectType: g.effectType, attributions: g.attributions, evidence, now: now ?? Date.now() });
    traces.push(t);
    const id = await append(t);
    if (id) written += 1;
  }
  return { built: traces.length, written, traces };
}
