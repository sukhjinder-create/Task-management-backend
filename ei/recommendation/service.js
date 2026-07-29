// ei/recommendation/service.js
//
// EI V2.1 Phase 6 — orchestration: turn Phase-5 predictions (each with its Phase-4
// trace) into recommendations. Deterministic, flag-gated, additive (not wired to any
// bus/endpoint → zero production change). "insufficient_basis" recommendations ARE
// produced (they surface "we do not know" honestly) but are always manual-only.

import { computeRecommendation } from "./engine.js";
import { appendRecommendation } from "./store.js";
import { isEiRecommendationEnabled } from "../config/flags.js";

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {Array}  args.predictions        Phase-5 predictions
 * @param {object} args.tracesById         map traceId -> Phase-4 trace
 * @param {object} [args.evidenceByEntity] map "Type:id" -> [evidence] (optional)
 * @param {object} [deps] { appendRecommendation }
 */
export async function recommendForWorkspace({ workspaceId, predictions = [], tracesById = {}, evidenceByEntity = {} } = {}, deps = {}) {
  if (!isEiRecommendationEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendRecommendation || appendRecommendation;

  const recommendations = [];
  let written = 0;
  for (const prediction of predictions) {
    const trace = tracesById[prediction.supportingReasoningTraceId];
    if (!trace) continue; // no explainable basis → no recommendation (constitutional)
    const ent = prediction.entity || {};
    const evidence = evidenceByEntity[`${ent.type}:${ent.id}`] || [];
    const rec = computeRecommendation({ workspaceId, prediction, trace, evidence });
    if (!rec) continue;
    recommendations.push(rec);
    const id = await append(rec);
    if (id) written += 1;
  }
  return { recommended: recommendations.length, written, recommendations };
}
