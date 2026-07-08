// ei/recommendation/recommendation.js
//
// EI V2.1 Phase 6 — the immutable Recommendation structure. A recommendation is a
// STRUCTURED proposal that always references its prediction, reasoning trace and
// evidence, always carries its uncertainty, supports alternatives, and can require
// approval or be manual-only. It contains NO natural language (narration is P8) and
// uses NO LLM. Deterministic, versioned, replay-safe. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const RECOMMENDATION_SCHEMA_VERSION = 1;

/** Lifecycle status of a recommendation (structured; drives approval/manual policy). */
export const REC_STATUS = Object.freeze({
  RECOMMENDED: "recommended",           // actionable proposal with sufficient basis
  INSUFFICIENT_BASIS: "insufficient_basis", // "we do not know" — surfaced, no action proposed
  MANUAL_REVIEW: "manual_review",       // basis exists but no automatable action is declared
});

/** Deterministic, replay-stable recommendation id. */
export function deriveRecommendationId({ workspaceId, recommendationType, entity, predictionId, traceId }) {
  const salient = JSON.stringify([workspaceId, recommendationType, entity?.type ?? null, entity?.id ?? null, predictionId ?? null, traceId ?? null]);
  return "rec_" + createHash("sha256").update(salient).digest("hex").slice(0, 40);
}

/**
 * Build an immutable recommendation. Enforces the constitutional invariants:
 *  - always references a prediction + reasoning trace (explainability);
 *  - carries structured uncertainty;
 *  - manualOnly is forced true whenever status !== "recommended".
 */
export function createRecommendation(fields) {
  const {
    workspaceId, entity, recommendationType, status,
    action = null, rationaleRefs = {}, alternatives = [], uncertainty = {},
    requiresApproval = true, approvalScope = null, manualOnly = false,
    assumptions = [], unknownFactors = {}, explanation = {}, provenance = {},
  } = fields;
  const effectiveManualOnly = manualOnly || status !== REC_STATUS.RECOMMENDED;
  return deepFreeze({
    recommendationId: deriveRecommendationId({
      workspaceId, recommendationType, entity,
      predictionId: rationaleRefs.predictionId, traceId: rationaleRefs.reasoningTraceId,
    }),
    eiVersion: "2.1",
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    entity,
    recommendationType,
    status,
    action,                                  // structured { verb, target, params } | null — never NL
    rationaleRefs,                           // { predictionId, reasoningTraceId, evidenceIds[], attributionIds[] }
    alternatives,                            // [{ factor?, value?, tier?, probability? }]
    uncertainty,                             // { probability, confidenceInterval, observedCoverage }
    requiresApproval: Boolean(requiresApproval) || effectiveManualOnly,
    approvalScope,                           // e.g. { object, verb, role, scope } | null
    manualOnly: effectiveManualOnly,
    assumptions,
    unknownFactors,
    explanation,                             // structured self-explanation { predicate, tier, band } — no NL
    provenance,                              // { engineVersion, catalogKey, inputPredictionId }
  });
}

/** @returns {{ok:boolean, errors:string[]}} — enforces "always references + always explains + always uncertain". */
export function validateRecommendation(r) {
  const errors = [];
  if (!r || typeof r !== "object") return { ok: false, errors: ["recommendation_must_be_object"] };
  if (!r.recommendationId) errors.push("missing_recommendationId");
  if (!r.recommendationType) errors.push("missing_recommendationType");
  if (!r.rationaleRefs?.predictionId) errors.push("missing_prediction_ref");      // always references a prediction
  if (!r.rationaleRefs?.reasoningTraceId) errors.push("missing_reasoning_ref");   // always references a trace
  if (!Object.values(REC_STATUS).includes(r.status)) errors.push("invalid_status");
  if (!r.uncertainty || typeof r.uncertainty !== "object") errors.push("missing_uncertainty");
  if (r.status !== REC_STATUS.RECOMMENDED && r.manualOnly !== true) errors.push("non_recommended_must_be_manual_only");
  if (r.action && typeof r.action === "string") errors.push("action_must_be_structured_not_text");
  return { ok: errors.length === 0, errors };
}
