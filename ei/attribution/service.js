// ei/attribution/service.js
//
// EI V2.1 §5′ — orchestration: read canonical events from the Phase-1 immutable
// log, deterministically compute attributions, append them (idempotently). This
// is the "transform events → attribution structures" capability. Flag-gated;
// NOT wired to the bus or any endpoint (purely additive — later phases/schedulers
// call it), so there is no production behavior change. Reuses the Phase-1 store,
// the engine, and the attribution store. Deterministic + replay-safe (idempotent
// append means re-running reproduces the same result).

import { readEvents } from "../events/eventStore.js";
import { computeAttributions } from "./engine.js";
import { appendAttribution } from "./store.js";
import { isEiAttributionEnabled } from "../config/flags.js";

/**
 * @param {{workspaceId:string, sinceSeq?:number, limit?:number}} args
 * @param {object} [deps]  { readEvents, computeAttributions, appendAttribution } for tests
 */
export async function runAttributionForWorkspace({ workspaceId, sinceSeq = 0, limit = 1000 } = {}, deps = {}) {
  if (!isEiAttributionEnabled(workspaceId)) return { skipped: "flag_off" };
  const read = deps.readEvents || readEvents;
  const compute = deps.computeAttributions || computeAttributions;
  const append = deps.appendAttribution || appendAttribution;

  const events = await read({ workspaceId, sinceSeq, limit });
  const attributions = compute({ workspaceId, events });

  let written = 0;
  for (const a of attributions) {
    const id = await append(a);
    if (id) written += 1;
  }
  const maxSeq = events.reduce((m, e) => Math.max(m, Number(e.seq) || 0), Number(sinceSeq) || 0);
  return { computed: attributions.length, written, maxSeq };
}
