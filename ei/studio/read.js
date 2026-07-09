// ei/studio/read.js
//
// Enterprise Intelligence Studio — PURE read helpers. This layer only EXPOSES the
// existing EI subsystems: it maps persisted rows back into the rich objects the
// existing pure engines already understand, and assembles cross-object search + a few
// relationship views. NO business logic is duplicated — computation is delegated to the
// existing engines (graph/validation/health/metrics/executive). Deterministic.

const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : (v ?? null); } catch { return v; } };
const P = parse;

// ── row → rich object mappers (inverse of the schema-tolerant stores) ──────────
export function rowToTrace(r) {
  if (!r) return null;
  if (r.trace_body_json) return P(r.trace_body_json);      // full trace was persisted verbatim
  return { traceId: r.trace_id, workspaceId: r.workspace_id, claim: P(r.claim_json), confidenceDecomposition: P(r.confidence_json) };
}
export function rowToPrediction(r) {
  if (!r) return null;
  return {
    predictionId: r.prediction_id, workspaceId: r.workspace_id, entity: P(r.entity_json), predictionType: r.prediction_type,
    predictionValue: r.prediction_value, probability: r.probability, confidenceInterval: { low: r.confidence_low, high: r.confidence_high },
    predictionHorizon: P(r.horizon_json), supportingReasoningTraceId: r.reasoning_trace_id, alternativeOutcomes: P(r.alternative_outcomes_json) || [],
    assumptions: P(r.assumptions_json) || [], observedUncertainty: P(r.observed_uncertainty_json) || {}, unknownFactors: P(r.unknown_factors_json) || {},
    historicalPerformance: P(r.historical_performance_json) || {}, provenance: P(r.provenance_json) || {},
  };
}
export function rowToRecommendation(r) {
  if (!r) return null;
  return {
    recommendationId: r.recommendation_id, workspaceId: r.workspace_id, entity: P(r.entity_json), recommendationType: r.recommendation_type,
    status: r.status, action: P(r.action_json), rationaleRefs: P(r.rationale_refs_json) || {}, alternatives: P(r.alternatives_json) || [],
    uncertainty: P(r.uncertainty_json) || {}, requiresApproval: r.requires_approval, manualOnly: r.manual_only,
    assumptions: P(r.assumptions_json) || [], unknownFactors: P(r.unknown_factors_json) || {}, explanation: P(r.explanation_json) || {},
  };
}
export function rowToOutcome(r) {
  if (!r) return null;
  return { outcomeId: r.outcome_id, workspaceId: r.workspace_id, kind: r.kind, status: r.status, subjectId: r.subject_id, refs: P(r.refs_json) || {}, observedAt: r.observed_at, actor: P(r.actor_json), impact: P(r.impact_json) };
}
export function rowToEvidence(r) {
  if (!r) return null;
  return { evidenceId: r.evidence_id, workspaceId: r.workspace_id, revisionKey: r.revision_key, entity: P(r.entity_json), attributionRef: P(r.attribution_ref_json), supportingEvidence: P(r.supporting_json) || [], contradictingEvidence: P(r.contradicting_json) || [], confidenceSource: r.confidence_source, temporalValidity: { from: r.temporal_from, to: r.temporal_to } };
}
export function rowToMemory(r) {
  if (!r) return null;
  return { memoryId: r.memory_id, workspaceId: r.workspace_id, kind: r.kind, key: r.key, revisionKey: r.revision_key, version: r.version, value: P(r.value_json), support: P(r.support_json) };
}
export function rowToProposal(r) {
  if (!r) return null;
  return { proposalId: r.proposal_id, workspaceId: r.workspace_id, kind: r.kind, target: r.target, admissible: r.admissible, status: r.status, evidence: P(r.evidence_json), cleanliness: P(r.cleanliness_json), rationaleRefs: P(r.rationale_refs_json), version: r.version };
}
export function rowToExperiment(r) {
  if (!r) return null;
  return { experimentId: r.experiment_id, workspaceId: r.workspace_id, key: r.key, design: r.design, arms: P(r.arms_json) || [], references: P(r.references_json) || {}, status: r.status, version: r.version };
}
// Attributions are stored as columns+json; expose a generic parsed view.
export function rowToAttribution(r) {
  if (!r) return null;
  return { attributionId: r.attribution_id || r.attributionId, workspaceId: r.workspace_id, ruleKey: r.rule_key, tier: r.tier, language: r.language, effect: P(r.effect_json), factor: P(r.factor_json), confidenceSource: r.confidence_source, associationStrength: r.association_strength, supportingEvidence: P(r.supporting_json) || [] };
}

/** Rows may already be objects (tests/DI) — map only when they look like DB rows. */
export function mapRows(rows, mapper) { return (rows || []).map((r) => (r && (r.trace_id || r.prediction_id || r.recommendation_id || r.outcome_id || r.evidence_id || r.memory_id || r.proposal_id || r.experiment_id) ? mapper(r) : r)); }

// ── global search across every intelligence object (pure) ──────────────────────
export function searchIntelligence(query, corpus = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const add = (type, id, label, route) => { if (id && String(id).toLowerCase().includes(q) || (label && String(label).toLowerCase().includes(q))) hits.push({ type, id, label, route }); };
  for (const e of corpus.evidence || []) add("evidence", e.evidenceId, `${e.entity?.type}:${e.entity?.id}`, `/intelligence-studio/evidence`);
  for (const a of corpus.attributions || []) add("attribution", a.attributionId, `${a.ruleKey} (${a.tier})`, `/intelligence-studio/attributions`);
  for (const t of corpus.traces || []) add("trace", t.traceId, `${t.claim?.predicate} · ${t.claim?.status}`, `/intelligence-studio/traces/${t.traceId}`);
  for (const p of corpus.predictions || []) add("prediction", p.predictionId, `${p.predictionType} · p=${p.probability}`, `/intelligence-studio/predictions/${p.predictionId}`);
  for (const r of corpus.recommendations || []) add("recommendation", r.recommendationId, `${r.recommendationType} · ${r.status}`, `/intelligence-studio/recommendations/${r.recommendationId}`);
  for (const o of corpus.outcomes || []) add("outcome", o.outcomeId, `${o.kind} · ${o.status}`, `/intelligence-studio/outcomes`);
  for (const x of corpus.experiments || []) add("experiment", x.experimentId, `${x.key} · ${x.design}`, `/intelligence-studio/experiments`);
  for (const lp of corpus.learning || []) add("learning", lp.proposalId, `${lp.kind} · ${lp.status}`, `/intelligence-studio/learning`);
  for (const m of corpus.memory || []) add("memory", m.memoryId, `${m.kind} · ${m.key}`, `/intelligence-studio/memory`);
  return hits.sort((a, b) => a.type.localeCompare(b.type) || String(a.id).localeCompare(String(b.id))).slice(0, 200);
}

/** Relationship view for a trace: everything it references + what references it. Pure. */
export function traceRelations(trace, { predictions = [], recommendations = [] } = {}) {
  if (!trace) return null;
  const preds = predictions.filter((p) => p.supportingReasoningTraceId === trace.traceId);
  const predIds = new Set(preds.map((p) => p.predictionId));
  const recs = recommendations.filter((r) => predIds.has(r.rationaleRefs?.predictionId));
  return {
    referencedEvidence: trace.referencedEvidence || [],
    referencedAttribution: trace.referencedAttribution || [],
    referencedEvents: trace.referencedEvents || [],
    predictions: preds.map((p) => p.predictionId),
    recommendations: recs.map((r) => r.recommendationId),
  };
}
