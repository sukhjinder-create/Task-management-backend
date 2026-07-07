// ei/prediction/engine.js
//
// EI V2.1 Phase 5 — the deterministic Prediction Engine. Consumes a reasoning
// trace (+ optional numeric series), fuses the ensemble members with FIXED,
// DECLARED weights (not learned), and emits a fully-explainable prediction that
// references the trace. No LLM. Deterministic. Confidence never asserts certainty.

import { attributionMember, trendMember } from "./members.js";
import { createPrediction } from "./prediction.js";

const DEFAULT_WEIGHTS = Object.freeze({ attribution_propagation: 0.6, trend: 0.4 });
const clamp01 = (x) => Math.min(1, Math.max(0, Math.round(x * 1e6) / 1e6));

/**
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {object} p.entity
 * @param {string} p.predictionType
 * @param {object} p.trace          a Phase-4 reasoning trace (required — explainability)
 * @param {Array}  [p.series]       optional numeric series for the trend member
 * @param {number} [p.horizonDays]
 * @param {object} [p.config]       { weights, historicalPerformance }
 * @returns {object|null}
 */
export function computePrediction({ workspaceId, entity, predictionType, trace, series = null, horizonDays = 14, config = {} } = {}) {
  if (!trace) return null; // predictions are never emitted without an explainable trace
  const weights = config.weights || DEFAULT_WEIGHTS;

  const members = [attributionMember(trace)];
  if (Array.isArray(series) && series.length >= 2) members.push(trendMember(series));

  const wsum = members.reduce((s, m) => s + (weights[m.method] || 0), 0) || 1;
  const probability = clamp01(members.reduce((s, m) => s + m.probability * (weights[m.method] || 0), 0) / wsum);

  // CI widens as trace confidence falls (deterministic); never a certain [x,1].
  const overall = trace.confidenceDecomposition?.overall ?? 0;
  const half = clamp01((1 - overall) * 0.5);
  const confidenceInterval = { low: clamp01(probability - half), high: clamp01(Math.min(0.99, probability + half)) };

  const predictionValue = probability >= 0.5 ? "likely" : "unlikely";

  // Assumptions = the (uncontrolled) confounders + the humility that unobserved drivers may act.
  const assumptions = [
    ...(trace.reasoningChain || [])
      .filter((s) => s.tier !== "O")
      .map((s) => ({ type: "attribution", factor: s.from?.descriptor ?? null, relation: s.relation })),
    { type: "humility", note: "unobserved drivers may contribute (see unknownFactors)" },
  ];

  return createPrediction({
    workspaceId, entity, predictionType,
    predictionValue, probability, confidenceInterval,
    predictionHorizon: { days: horizonDays },
    supportingReasoningTraceId: trace.traceId,
    alternativeOutcomes: [{ value: `not_${predictionValue}`, probability: clamp01(1 - probability) }],
    assumptions,
    observedUncertainty: trace.observedUncertainty || {},
    unknownFactors: trace.unknownFactors || {},
    historicalPerformance: config.historicalPerformance || { evaluations: 0, note: "no prior evaluations" },
    provenance: { engineVersion: "ei-pred-1", members: members.map((m) => m.method), weights, inputTraceId: trace.traceId },
  });
}
