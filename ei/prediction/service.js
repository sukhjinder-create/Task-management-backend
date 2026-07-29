// ei/prediction/service.js
//
// EI V2.1 Phase 5 — orchestration: turn Phase-4 reasoning traces into predictions.
// Traces with status "insufficient_basis" ("we do not know") produce NO prediction
// (constitutional humility). Deterministic, flag-gated, additive.

import { computePrediction } from "./engine.js";
import { appendPrediction } from "./store.js";
import { isEiPredictionEnabled } from "../config/flags.js";

/**
 * @param {{workspaceId:string, traces:Array, seriesByEntity?:object, horizonDays?:number}} args
 * @param {object} [deps] { appendPrediction }
 */
export async function predictForWorkspace({ workspaceId, traces = [], seriesByEntity = {}, horizonDays = 14 } = {}, deps = {}) {
  if (!isEiPredictionEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendPrediction || appendPrediction;

  const predictions = [];
  let written = 0;
  for (const t of traces) {
    if (t.claim?.status !== "attributed") continue; // "we do not know" → no prediction
    const entity = t.claim.entity;
    const series = seriesByEntity[`${entity?.type}:${entity?.id}`] || null;
    const p = computePrediction({ workspaceId, entity, predictionType: `risk:${t.claim.predicate}`, trace: t, series, horizonDays });
    if (!p) continue;
    predictions.push(p);
    const id = await append(p);
    if (id) written += 1;
  }
  return { predicted: predictions.length, written, predictions };
}
