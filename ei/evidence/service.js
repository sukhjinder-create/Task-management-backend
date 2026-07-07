// ei/evidence/service.js
//
// EI V2.1 Phase 3 — orchestration: project Phase-2 attributions into immutable
// evidence records. Deterministic + replay-safe (idempotent append). Flag-gated;
// not wired to any bus/endpoint (additive → zero production change). Reuses the
// Phase-2 attribution store.

import { listAttributions } from "../attribution/store.js";
import { fromAttribution } from "./evidence.js";
import { appendEvidence } from "./store.js";
import { isEiEvidenceEnabled } from "../config/flags.js";

/**
 * @param {{workspaceId:string, attributions?:Array}} args
 * @param {object} [deps] { listAttributions, appendEvidence }
 */
export async function buildEvidenceForWorkspace({ workspaceId, attributions = null } = {}, deps = {}) {
  if (!isEiEvidenceEnabled(workspaceId)) return { skipped: "flag_off" };
  const list = deps.listAttributions || listAttributions;
  const append = deps.appendEvidence || appendEvidence;

  const source = attributions || (await list({ workspaceId }));
  let written = 0;
  const records = [];
  for (const a of source) {
    const e = fromAttribution(a);
    if (!e) continue;
    records.push(e);
    const id = await append(e);
    if (id) written += 1;
  }
  return { projected: records.length, written };
}
