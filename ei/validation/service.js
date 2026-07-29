// ei/validation/service.js
//
// EI V2.1 Wave C — orchestration for prediction validation. Deterministic, flag-gated,
// additive, computed (pure projection of immutable predictions + outcomes).

import { validatePredictionOutcomes } from "./validation.js";
import { isEiValidationEnabled } from "../config/flags.js";

/** @param {object} args { workspaceId, predictions, outcomes } */
export async function validateWorkspacePredictions({ workspaceId, predictions = [], outcomes = [] } = {}) {
  if (!isEiValidationEnabled(workspaceId)) return { skipped: "flag_off" };
  const predOutcomes = outcomes.filter((o) => o.kind === "prediction" || o.refs?.predictionId || o.predictionId);
  const report = validatePredictionOutcomes({ predictions, outcomes: predOutcomes });
  return { workspaceId: String(workspaceId), eiVersion: "2.1", ...report };
}
