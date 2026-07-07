// ei/reasoning/builder.js
//
// EI V2.1 Phase 4 — assembles a structured Reasoning Trace for one (effect entity,
// effect type) from Phase-2 attributions (+ optional Phase-3 evidence + prior
// traces). Pure & deterministic (given the same inputs + evaluation time). No LLM,
// no narration. Downgrades to "insufficient_basis" ("we do not know") when
// observed coverage is too low.

import { createHash } from "node:crypto";
import { createTrace, decomposeConfidence, estimateObservedCoverage, unknownFactorsFor, COVERAGE_THRESHOLD } from "./trace.js";

const TIER_RANK = { C: 3, A: 2, O: 1 };
const inputHash = (ids) => "in_" + createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex").slice(0, 24);

export function buildTrace({ workspaceId, effectEntity, effectType, attributions = [], evidence = [], priorTraces = [], now = Date.now() }) {
  const chain = attributions.slice().sort(
    (a, b) => (TIER_RANK[b.tier] - TIER_RANK[a.tier]) || ((b.associationStrength || 0) - (a.associationStrength || 0)) || a.attributionId.localeCompare(b.attributionId)
  );
  const strongest = chain[0] || null;
  const supportCount = chain.reduce((n, a) => n + (a.supportingEvidence?.length || 0), 0);
  const contradictionCount = chain.reduce((n, a) => n + (a.contradictingEvidence?.length || 0), 0);
  const observedCoverage = estimateObservedCoverage({ supportCount, contradictionCount });

  const latestTs = chain.flatMap((a) => (a.supportingEvidence || []).map((e) => new Date(e.occurredAt).getTime())).reduce((m, t) => Math.max(m, t || 0), 0);
  const recencyDays = latestTs ? Math.max(0, (now - latestTs) / 86400000) : 999;
  const assoc = strongest && strongest.tier !== "O" ? strongest.associationStrength : null;

  const confidenceDecomposition = decomposeConfidence({ tier: strongest?.tier || "O", supportCount, associationStrength: assoc, observedCoverage, recencyDays });
  const insufficient = supportCount === 0 || observedCoverage < COVERAGE_THRESHOLD;

  const claim = { entity: effectEntity, predicate: effectType, tier: strongest?.tier || "O", status: insufficient ? "insufficient_basis" : "attributed" };

  const reasoningChain = chain.map((a) => ({ from: a.factor, relation: a.language, to: { entity: a.effect?.entity, type: a.effect?.type }, tier: a.tier, evidenceRefs: a.supportingEvidence || [] }));
  const seen = new Set();
  const alternativeHypotheses = chain.slice(1)
    .filter((a) => { const k = a.factor?.descriptor; if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .map((a) => ({ factor: a.factor, tier: a.tier, associationStrength: a.associationStrength ?? null, ruleKey: a.ruleKey }));

  const referencedAttribution = chain.map((a) => a.attributionId);
  const referencedEvents = [...new Set(chain.flatMap((a) => a.provenance?.sourceEventIds || []))];
  const referencedGraphNodes = [...new Set(
    chain.flatMap((a) => [a.effect?.entity, a.factor?.entity]).filter((e) => e && e.id != null).map((e) => `${e.type}:${e.id}`)
  )];

  return createTrace({
    workspaceId, claim,
    supportingEvidence: chain.flatMap((a) => a.supportingEvidence || []),
    contradictingEvidence: chain.flatMap((a) => a.contradictingEvidence || []),
    attributionChain: chain.map((a) => ({ attributionId: a.attributionId, tier: a.tier, ruleKey: a.ruleKey, associationStrength: a.associationStrength ?? null })),
    reasoningChain,
    confidenceDecomposition,
    observedUncertainty: { observedCoverage, contradictionCount, note: insufficient ? "insufficient basis to attribute" : null },
    unknownFactors: unknownFactorsFor(effectType),
    alternativeHypotheses,
    historicalComparison: priorTraces.map((t) => ({ traceId: t.traceId, overall: t.confidenceDecomposition?.overall ?? null })),
    referencedEvents,
    referencedEvidence: evidence.map((e) => e.evidenceId).filter(Boolean),
    referencedAttribution,
    referencedGraphNodes,
    inputHash: inputHash(referencedAttribution),
  });
}
