// ei/effectiveness/service.js
//
// EI V2.1 Wave C — orchestration for recommendation effectiveness. Deterministic,
// flag-gated, additive, computed (no persistence — a pure projection of immutable
// recommendations + outcomes).

import { computeEffectiveness } from "./effectiveness.js";
import { isEiEffectivenessEnabled } from "../config/flags.js";

/**
 * @param {object} args { workspaceId, recommendations, outcomes, dimension?, createdAtByRecommendation?, dimensionByRecommendation? }
 */
export async function computeRecommendationEffectiveness({ workspaceId, recommendations = [], outcomes = [], dimension = "type", createdAtByRecommendation = null, dimensionByRecommendation = null } = {}) {
  if (!isEiEffectivenessEnabled(workspaceId)) return { skipped: "flag_off" };
  const report = computeEffectiveness({ recommendations, outcomes, dimension, createdAtByRecommendation, dimensionByRecommendation });
  return { workspaceId: String(workspaceId), eiVersion: "2.1", ...report };
}
