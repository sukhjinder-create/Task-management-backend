// ei/prediction/prediction.js
//
// EI V2.1 Phase 5 — the immutable Prediction structure. Every prediction references
// a reasoning trace (its full explanation). Deterministic, versioned, no LLM.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const PREDICTION_SCHEMA_VERSION = 1;
const UNKNOWN_UNKNOWNS_CAP = 0.85; // probability confidence never certain

export function derivePredictionId({ workspaceId, entity, predictionType, traceId }) {
  const salient = JSON.stringify([workspaceId, predictionType, entity?.type, entity?.id, traceId]);
  return "pred_" + createHash("sha256").update(salient).digest("hex").slice(0, 40);
}

export function createPrediction(fields) {
  const { workspaceId, entity, predictionType, predictionValue, probability, confidenceInterval,
    predictionHorizon, supportingReasoningTraceId, alternativeOutcomes = [], assumptions = [],
    observedUncertainty = {}, unknownFactors = {}, historicalPerformance = {}, provenance = {} } = fields;
  return deepFreeze({
    predictionId: derivePredictionId({ workspaceId, entity, predictionType, traceId: supportingReasoningTraceId }),
    eiVersion: "2.1",
    schemaVersion: PREDICTION_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    entity,
    predictionType,
    predictionValue,
    probability,
    confidenceInterval,
    predictionHorizon,                       // { days }
    supportingReasoningTraceId,
    alternativeOutcomes,
    assumptions,
    observedUncertainty,
    unknownFactors,
    historicalPerformance,
    provenance,                              // { engineVersion, members, inputTraceId }
  });
}

export function validatePrediction(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["prediction_must_be_object"] };
  if (!p.predictionId) errors.push("missing_predictionId");
  if (!p.predictionType) errors.push("missing_predictionType");
  if (!p.supportingReasoningTraceId) errors.push("missing_reasoning_trace"); // every prediction is explainable
  if (!(p.probability >= 0 && p.probability <= 1)) errors.push("probability_out_of_range");
  if (p.probability > UNKNOWN_UNKNOWNS_CAP && p.confidenceInterval?.high === 1) errors.push("overconfident_certainty");
  return { ok: errors.length === 0, errors };
}
