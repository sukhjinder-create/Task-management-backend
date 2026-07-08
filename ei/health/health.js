// ei/health/health.js
//
// EI V2.1 Wave C — Platform Health. A PURE, deterministic projection that scores the
// health of the intelligence platform across reasoning / prediction / recommendation
// quality, coverage, confidence & calibration quality, unknown rate, evidence quality,
// graph completeness, and organizational-learning maturity. Anything that needs outcome
// data absent from the corpus is reported insufficient — never fabricated. No new store.

function round(x, dp = 4) { return x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp; }
function ok(key, label, value, basis) { return { key, label, value, evidenceSufficient: true, basis }; }
function gap(key, label, reason) { return { key, label, value: null, evidenceSufficient: false, reason }; }

/**
 * @param {object} c corpus { traces, predictions, recommendations, evidence, outcomes,
 *                            validation, effectiveness, calibrationModel, memory, graph, experiments, proposals }
 * @returns {object[]} metrics (deterministic order)
 */
export function computeHealth(c = {}) {
  const traces = c.traces || [], predictions = c.predictions || [], recommendations = c.recommendations || [];
  const outcomes = c.outcomes || [], memory = c.memory || [], experiments = c.experiments || [], proposals = c.proposals || [];
  const traceIds = new Set(traces.map((t) => t.traceId));
  const m = [];

  // reasoning quality = predictions whose reasoning trace resolves.
  if (predictions.length) {
    const explained = predictions.filter((p) => p.supportingReasoningTraceId && traceIds.has(p.supportingReasoningTraceId)).length;
    m.push(ok("reasoning_quality", "Predictions with resolvable reasoning", round(explained / predictions.length), { explained, total: predictions.length }));
  } else m.push(gap("reasoning_quality", "Predictions with resolvable reasoning", "no predictions in corpus"));

  // prediction quality = validated accuracy.
  const acc = c.validation?.metrics?.accuracy;
  m.push(acc?.evidenceSufficient ? ok("prediction_quality", "Validated prediction accuracy", acc.value, acc.basis) : gap("prediction_quality", "Validated prediction accuracy", "requires validated outcomes"));

  // recommendation quality = measured effectiveness.
  const eff = c.effectiveness?.overall?.effectiveness;
  m.push(eff?.evidenceSufficient ? ok("recommendation_quality", "Measured recommendation effectiveness", eff.value, eff.basis) : gap("recommendation_quality", "Measured recommendation effectiveness", "requires measured recommendation impact"));

  // coverage = entities reasoned about / entities present (from the graph).
  if (c.graph?.nodes?.length) {
    const entityNodes = c.graph.nodes.filter((n) => n.type === "entity");
    const subjectOf = new Set(c.graph.edges.filter((e) => e.rel === "subject_of").map((e) => e.from));
    m.push(entityNodes.length ? ok("coverage", "Entities with reasoning coverage", round(entityNodes.filter((n) => subjectOf.has(n.id)).length / entityNodes.length), { entities: entityNodes.length }) : gap("coverage", "Entities with reasoning coverage", "no entities in graph"));
  } else m.push(gap("coverage", "Entities with reasoning coverage", "no graph supplied"));

  // confidence + calibration quality = from validation calibration.
  const calQ = c.validation?.metrics?.calibrationQuality;
  m.push(calQ?.evidenceSufficient ? ok("confidence_quality", "Confidence calibration quality", calQ.value, calQ.basis) : gap("confidence_quality", "Confidence calibration quality", "requires validated outcomes"));
  m.push(c.calibrationModel ? ok("calibration_quality", "Calibration model present", 1, { version: c.calibrationModel.version, buckets: c.calibrationModel.buckets?.length ?? 0 }) : gap("calibration_quality", "Calibration model present", "no calibration model built yet"));

  // unknown rate = (insufficient-basis traces + unknown validations) / total signals.
  const unknownTraces = traces.filter((t) => t.claim?.status === "insufficient_basis").length;
  const unknownPreds = c.validation?.counts?.unknown ?? predictions.length; // if no validation, all predictions are unknown-outcome
  const denom = traces.length + predictions.length;
  m.push(denom ? ok("unknown_rate", "Share of signals we cannot yet resolve", round((unknownTraces + unknownPreds) / denom), { unknownTraces, unknownPreds, denom }) : gap("unknown_rate", "Share of signals we cannot yet resolve", "no traces or predictions"));

  // evidence quality = traces carrying supporting evidence refs.
  m.push(traces.length ? ok("evidence_quality", "Traces backed by evidence references", round(traces.filter((t) => (t.referencedEvidence || []).length > 0).length / traces.length), { traces: traces.length }) : gap("evidence_quality", "Traces backed by evidence references", "no traces in corpus"));

  // graph completeness = predictions that reach a recommendation (predicts→recommends).
  if (c.graph?.edges?.length) {
    const predicts = c.graph.edges.filter((e) => e.rel === "predicts").map((e) => e.to);
    const recommendsFrom = new Set(c.graph.edges.filter((e) => e.rel === "recommends").map((e) => e.from));
    m.push(predicts.length ? ok("graph_completeness", "Predictions carried through to a recommendation", round(predicts.filter((p) => recommendsFrom.has(p)).length / predicts.length), { predictions: predicts.length }) : gap("graph_completeness", "Predictions carried through to a recommendation", "no prediction edges in graph"));
  } else m.push(gap("graph_completeness", "Predictions carried through to a recommendation", "no graph supplied"));

  // organizational learning maturity = deterministic stage from what exists.
  const verifiedOutcomes = outcomes.filter((o) => ["confirmed", "refuted", "partially_confirmed", "executed", "partially_executed"].includes(o.status)).length;
  let stage = 0, label = "no_outcomes";
  if (verifiedOutcomes > 0) { stage = 1; label = "outcomes_recorded"; }
  if (acc?.evidenceSufficient) { stage = 2; label = "validated"; }
  if (c.calibrationModel && memory.length) { stage = 3; label = "calibrated_and_remembering"; }
  if (experiments.some((x) => x.design === "holdout") && proposals.length) { stage = 4; label = "experimenting_and_proposing"; }
  m.push(ok("organizational_learning_maturity", "Closed-loop learning maturity (stage 0–4)", { stage, label }, { verifiedOutcomes, memory: memory.length, experiments: experiments.length, proposals: proposals.length }));

  return m;
}
