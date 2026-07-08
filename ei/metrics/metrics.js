// ei/metrics/metrics.js
//
// EI V2.1 — deterministic, evidence-backed platform/value metrics. THE CENTRAL RULE:
// a metric is only reported with a number when the evidence to compute it exists in
// the corpus. Metrics that structurally require OUTCOME history (did a recommendation
// get adopted? was a prediction correct? were hours actually saved?) are returned as
// { evidenceSufficient: false, reason } — never fabricated. Every reported metric
// carries its `basis` (the counts it was computed from) so it is fully auditable.
// No LLM. Pure.

function round(x, dp = 4) { return x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp; }

function ok(key, label, value, basis) { return { key, label, value, evidenceSufficient: true, basis }; }
function gap(key, label, reason) { return { key, label, value: null, evidenceSufficient: false, reason }; }

/**
 * @param {object} corpus { traces, predictions, recommendations, evidence }
 * @returns {object[]} array of metric objects (deterministic order)
 */
export function computeMetrics(corpus = {}) {
  const traces = corpus.traces || [];
  const predictions = corpus.predictions || [];
  const recommendations = corpus.recommendations || [];
  const evidence = corpus.evidence || [];

  const traceIds = new Set(traces.map((t) => t.traceId));
  const attributionIds = new Set(traces.flatMap((t) => t.referencedAttribution || []));

  const metrics = [];

  // ── Structural / process metrics (fully evidence-backed from EI records) ──────
  metrics.push(ok("trace_count", "Reasoning traces produced", traces.length, { traces: traces.length }));
  metrics.push(ok("prediction_count", "Predictions produced", predictions.length, { predictions: predictions.length }));
  metrics.push(ok("recommendation_count", "Recommendations produced", recommendations.length, { recommendations: recommendations.length }));
  metrics.push(ok("evidence_count", "Evidence records", evidence.length, { evidence: evidence.length }));
  metrics.push(ok("attribution_count", "Distinct attributions referenced", attributionIds.size, { attributions: attributionIds.size }));

  // Explainability coverage: fraction of predictions whose supporting trace is present.
  if (predictions.length > 0) {
    const explained = predictions.filter((p) => p.supportingReasoningTraceId && traceIds.has(p.supportingReasoningTraceId)).length;
    metrics.push(ok("explainability_coverage", "Predictions with a resolvable reasoning trace", round(explained / predictions.length), { explained, total: predictions.length }));
  } else {
    metrics.push(gap("explainability_coverage", "Predictions with a resolvable reasoning trace", "no predictions in corpus"));
  }

  // Humility coverage: fraction of predictions carrying unknown-factor humility.
  if (predictions.length > 0) {
    const humble = predictions.filter((p) => p.unknownFactors && Object.keys(p.unknownFactors).length > 0).length;
    metrics.push(ok("humility_coverage", "Predictions declaring unknown factors", round(humble / predictions.length), { humble, total: predictions.length }));
  } else {
    metrics.push(gap("humility_coverage", "Predictions declaring unknown factors", "no predictions in corpus"));
  }

  // Insufficient-basis rate: how often the pipeline said "we do not know".
  if (traces.length > 0) {
    const unknown = traces.filter((t) => t.claim?.status === "insufficient_basis").length;
    metrics.push(ok("insufficient_basis_rate", "Claims marked 'we do not know'", round(unknown / traces.length), { unknown, total: traces.length }));
  } else {
    metrics.push(gap("insufficient_basis_rate", "Claims marked 'we do not know'", "no traces in corpus"));
  }

  // Attribution tier distribution (transparency of causal strength).
  const tierCounts = { O: 0, A: 0, C: 0 };
  for (const t of traces) for (const a of t.attributionChain || []) if (a.tier in tierCounts) tierCounts[a.tier] += 1;
  metrics.push(ok("attribution_tier_distribution", "Observed / Associated / Causal mix", tierCounts, tierCounts));

  // Recommendation actionability & manual-review rates.
  if (recommendations.length > 0) {
    const actionable = recommendations.filter((r) => r.status === "recommended").length;
    const manual = recommendations.filter((r) => r.manualOnly).length;
    metrics.push(ok("recommendation_actionability_rate", "Recommendations with an actionable proposal", round(actionable / recommendations.length), { actionable, total: recommendations.length }));
    metrics.push(ok("manual_review_rate", "Recommendations routed to manual review", round(manual / recommendations.length), { manual, total: recommendations.length }));
  } else {
    metrics.push(gap("recommendation_actionability_rate", "Recommendations with an actionable proposal", "no recommendations in corpus"));
    metrics.push(gap("manual_review_rate", "Recommendations routed to manual review", "no recommendations in corpus"));
  }

  // Structural intelligence index: transparent composite of PROCESS coverage only.
  // It measures how well the platform explains itself — NOT business outcomes.
  const expl = metrics.find((m) => m.key === "explainability_coverage");
  const hum = metrics.find((m) => m.key === "humility_coverage");
  if (expl?.evidenceSufficient && hum?.evidenceSufficient) {
    metrics.push(ok("structural_intelligence_index", "Self-explanation coverage (process, not outcomes)", round((expl.value + hum.value) / 2), { explainability: expl.value, humility: hum.value, note: "process quality only — does not assert business impact" }));
  } else {
    metrics.push(gap("structural_intelligence_index", "Self-explanation coverage (process, not outcomes)", "insufficient records to compute coverage"));
  }

  // ── Outcome-dependent metrics — reported as GAPS (never fabricated) ───────────
  const OUTCOME_REASON = "requires outcome history (recommendation → execution → measured outcome), not yet recorded — deferred to the learning/calibration wave";
  const LONGITUDINAL_REASON = "requires longitudinal baseline (before/after measurement), not yet recorded";
  metrics.push(gap("recommendation_adoption_rate", "Recommendations accepted vs. produced", OUTCOME_REASON));
  metrics.push(gap("prediction_accuracy", "Predictions confirmed by outcome", OUTCOME_REASON));
  metrics.push(gap("hours_saved", "Estimated hours saved", OUTCOME_REASON));
  metrics.push(gap("delivery_improvement", "Delivery improvement", LONGITUDINAL_REASON));
  metrics.push(gap("decision_latency_reduction", "Decision latency reduction", LONGITUDINAL_REASON));
  metrics.push(gap("risk_prevented", "Risks prevented", OUTCOME_REASON));
  metrics.push(gap("adaptive_learning_rate", "Adaptive learning rate", OUTCOME_REASON));
  metrics.push(gap("business_improvement_score", "Business improvement score", OUTCOME_REASON));
  metrics.push(gap("platform_intelligence_score", "Platform intelligence score (business outcomes)", "requires outcome-validated metrics (accuracy, adoption, impact) — the structural_intelligence_index measures process quality only"));

  return metrics;
}
