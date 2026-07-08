// ei/recommendation/engine.js
//
// EI V2.1 Phase 6 — the deterministic Recommendation Engine. Consumes a Phase-5
// prediction + its Phase-4 reasoning trace (+ optional Phase-3 evidence) and emits a
// fully-referenced, self-explaining recommendation. No LLM. Deterministic. It never
// proposes an action without an explainable prediction+trace, downgrades weak/absent
// basis to "insufficient_basis", and routes actionless or high-impact cases to
// manual review.

import { createRecommendation, REC_STATUS } from "./recommendation.js";
import { policyFor } from "./catalog.js";

/** Map an overall-confidence figure to a coarse, deterministic band (structured, not NL). */
function confidenceBand(overall = 0) {
  if (overall >= 0.66) return "high";
  if (overall >= 0.33) return "moderate";
  return "low";
}

/**
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {object} p.prediction   a Phase-5 prediction (required)
 * @param {object} p.trace        the Phase-4 trace the prediction references (required)
 * @param {Array}  [p.evidence]   Phase-3 evidence records for the entity (optional; ids also on the trace)
 * @returns {object|null}
 */
export function computeRecommendation({ workspaceId, prediction, trace, evidence = [] } = {}) {
  if (!prediction || !trace) return null; // never recommend without an explainable basis

  const policy = policyFor(prediction.predictionType);
  const entity = prediction.entity || trace.claim?.entity || { type: null, id: null };
  const overall = trace.confidenceDecomposition?.overall ?? 0;

  // Basis gate: "we do not know" (trace) or weak prediction → insufficient basis.
  const insufficient = trace.claim?.status !== "attributed" || (prediction.probability ?? 0) < policy.minProbability;
  // No declared action for this prediction type → surface for manual review.
  const noAction = !policy.action;

  const status = insufficient ? REC_STATUS.INSUFFICIENT_BASIS : (noAction ? REC_STATUS.MANUAL_REVIEW : REC_STATUS.RECOMMENDED);

  const evidenceIds = [
    ...new Set([...(trace.referencedEvidence || []), ...evidence.map((e) => e && e.evidenceId).filter(Boolean)]),
  ].sort();

  const rationaleRefs = {
    predictionId: prediction.predictionId,
    reasoningTraceId: trace.traceId,
    evidenceIds,
    attributionIds: [...(trace.referencedAttribution || [])].sort(),
  };

  // Alternatives: alternative reasoning hypotheses + the prediction's alternative outcomes.
  const alternatives = [
    ...(trace.alternativeHypotheses || []).map((h) => ({ kind: "hypothesis", factor: h.factor?.descriptor ?? null, tier: h.tier, associationStrength: h.associationStrength ?? null })),
    ...(prediction.alternativeOutcomes || []).map((o) => ({ kind: "outcome", value: o.value, probability: o.probability })),
  ];

  const uncertainty = {
    probability: prediction.probability ?? null,
    confidenceInterval: prediction.confidenceInterval ?? null,
    observedCoverage: trace.observedUncertainty?.observedCoverage ?? null,
    band: confidenceBand(overall),
  };

  return createRecommendation({
    workspaceId, entity,
    recommendationType: policy.recommendationType,
    status,
    action: status === REC_STATUS.RECOMMENDED ? policy.action : null,
    rationaleRefs,
    alternatives,
    uncertainty,
    requiresApproval: policy.requiresApproval,
    approvalScope: status === REC_STATUS.RECOMMENDED
      ? { object: entity.type, verb: policy.action?.verb ?? null, scope: { workspaceId: String(workspaceId) } }
      : null,
    manualOnly: policy.manualOnly,
    assumptions: prediction.assumptions || [],
    unknownFactors: trace.unknownFactors || {},
    explanation: {                          // structured self-explanation (no NL — narration is P8)
      predicate: trace.claim?.predicate ?? null,
      tier: trace.claim?.tier ?? null,
      basisStatus: trace.claim?.status ?? null,
      confidenceBand: uncertainty.band,
      reason: insufficient ? "insufficient_basis" : (noAction ? "no_declared_action" : "sufficient_basis"),
    },
    provenance: { engineVersion: "ei-rec-1", catalogKey: policy.catalogKey, inputPredictionId: prediction.predictionId, inputTraceId: trace.traceId },
  });
}
