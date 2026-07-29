// ei/reasoning/trace.js
//
// EI V2.1 Phase 4 — the immutable, PURELY STRUCTURED Reasoning Trace (no natural
// language, no narration, no LLM). It also computes the deterministic CONFIDENCE
// DECOMPOSITION (§13) and the OBSERVED-UNCERTAINTY / UNKNOWN-FACTORS humility
// (§14b) — decomposition ≠ calibration (calibration/learning is a later wave).
// Deterministic + replay-safe. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const TRACE_VERSION = 1;
const SATURATION = 5;          // support count at which data completeness saturates
const RECENCY_HALFLIFE_DAYS = 30;
const UNKNOWN_UNKNOWNS_CAP = 0.85;   // confidence never reaches 1.0 (residual unobserved drivers)
const COVERAGE_THRESHOLD = 0.25;     // below this → "we do not know"

// Domains known to be poorly observable from the event log (streetlight humility).
const ILLEGIBLE_DRIVERS = Object.freeze(["morale", "politics", "tacit_knowledge", "trust"]);

function clamp01(x) { return Math.min(1, Math.max(0, Math.round(x * 1e6) / 1e6)); }

/** Deterministic observed-coverage estimate from evidence density (0..1). */
export function estimateObservedCoverage({ supportCount = 0, contradictionCount = 0 }) {
  const density = (supportCount + contradictionCount) / (SATURATION * 2);
  return clamp01(Math.min(1, density));
}

/**
 * Deterministic confidence decomposition. Never calibrated; purely a function of
 * the data. `overall` is capped by observed coverage AND the unknown-unknowns floor.
 */
export function decomposeConfidence({ tier, supportCount = 0, associationStrength = null, observedCoverage = 0, recencyDays = 0 }) {
  const dataCompleteness = clamp01(Math.min(1, supportCount / SATURATION));
  const signalStrength = tier === "O" ? clamp01(Math.min(1, supportCount / 3)) : clamp01(associationStrength ?? 0);
  const recency = clamp01(Math.exp(-Math.max(0, recencyDays) / RECENCY_HALFLIFE_DAYS));
  const base = clamp01(0.5 * signalStrength + 0.3 * dataCompleteness + 0.2 * recency);
  const overall = clamp01(Math.min(UNKNOWN_UNKNOWNS_CAP, observedCoverage, base));
  return {
    dataCompleteness, signalStrength, recency,
    unknownUnknownsFloor: 1 - UNKNOWN_UNKNOWNS_CAP,
    observedCoverage: clamp01(observedCoverage),
    overall,
  };
}

/** Unknown-factors humility: which illegible driver domains might be missing here. */
export function unknownFactorsFor(effectType) {
  return { illegibleDrivers: ILLEGIBLE_DRIVERS, note: "unobserved drivers may contribute; not measurable from the event log", effectType };
}

export function deriveTraceId({ workspaceId, claim, attributionIds, inputHash }) {
  const salient = JSON.stringify([workspaceId, claim?.predicate, claim?.entity?.type, claim?.entity?.id, [...attributionIds].sort(), inputHash]);
  return "trace_" + createHash("sha256").update(salient).digest("hex").slice(0, 40);
}

/** Assemble an immutable, structured reasoning trace. */
export function createTrace(fields) {
  const {
    workspaceId, claim, attributionChain = [], reasoningChain = [],
    confidenceDecomposition, observedUncertainty, unknownFactors,
    alternativeHypotheses = [], historicalComparison = [],
    referencedEvents = [], referencedEvidence = [], referencedAttribution = [], referencedGraphNodes = [],
    inputHash = "",
  } = fields;
  const attributionIds = attributionChain.map((a) => a.attributionId || a);
  return deepFreeze({
    traceId: deriveTraceId({ workspaceId, claim, attributionIds, inputHash }),
    eiVersion: "2.1",
    traceVersion: TRACE_VERSION,
    workspaceId: String(workspaceId),
    claim,                          // { entity, predicate, tier, status }  (structured, no NL)
    supportingEvidence: fields.supportingEvidence || [],
    contradictingEvidence: fields.contradictingEvidence || [],
    attributionChain,
    reasoningChain,                 // [{ from, relation, to, evidenceRefs }]
    confidenceDecomposition,
    observedUncertainty,
    unknownFactors,
    alternativeHypotheses,
    historicalComparison,
    referencedEvents,
    referencedEvidence,
    referencedAttribution,
    referencedGraphNodes,
    provenance: { engineVersion: "ei-trace-1", inputHash },
  });
}

export function validateTrace(t) {
  const errors = [];
  if (!t || typeof t !== "object") return { ok: false, errors: ["trace_must_be_object"] };
  if (!t.traceId) errors.push("missing_traceId");
  if (!t.claim) errors.push("missing_claim");
  if (!t.confidenceDecomposition) errors.push("missing_confidenceDecomposition");
  if (t.confidenceDecomposition && t.confidenceDecomposition.overall > UNKNOWN_UNKNOWNS_CAP) errors.push("confidence_exceeds_unknown_unknowns_cap");
  if (!t.unknownFactors) errors.push("missing_unknownFactors");
  return { ok: errors.length === 0, errors };
}

export { COVERAGE_THRESHOLD, UNKNOWN_UNKNOWNS_CAP };
