// ei/effectiveness/effectiveness.js
//
// EI V2.1 Wave C — Recommendation Effectiveness. A PURE, deterministic projection
// over recommendations + their outcomes (no new store). Computes acceptance /
// execution / completion rates, time-to-action / time-to-outcome, expected vs actual
// impact, and an effectiveness score — grouped by a chosen dimension (recommendation
// type, workspace, team, project). Metrics that need data the ledger doesn't yet
// carry (timestamps, measured impact) are returned insufficient — never fabricated.

function round(x, dp = 4) { return x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp; }
function ok(value, basis) { return { value, evidenceSufficient: true, basis }; }
function gap(reason) { return { value: null, evidenceSufficient: false, reason }; }

const ACCEPTED = new Set(["accepted", "executed", "partially_executed"]);
const EXECUTED = new Set(["executed", "partially_executed"]);
const COMPLETED = new Set(["executed"]);

function dimensionKey(rec, dimension, dimensionByRecommendation) {
  const mapped = dimensionByRecommendation?.[rec.recommendationId];
  if (mapped) return String(mapped);
  switch (dimension) {
    case "type": return rec.recommendationType || "unknown";
    case "workspace": return rec.workspaceId || "unknown";
    case "project": return rec.entity?.type === "Project" ? `Project:${rec.entity.id}` : "unmapped_project";
    case "team": return "unmapped_team"; // teams require an org mapping not present on the record
    default: return rec.recommendationType || "unknown";
  }
}

function groupMetrics(recs, outcomesByRec, createdAtByRecommendation) {
  const population = recs.length;
  const withOutcomes = recs.filter((r) => (outcomesByRec.get(r.recommendationId) || []).length > 0);
  const statusesOf = (r) => new Set((outcomesByRec.get(r.recommendationId) || []).map((o) => o.status));

  const accepted = recs.filter((r) => [...statusesOf(r)].some((s) => ACCEPTED.has(s)));
  const executed = recs.filter((r) => [...statusesOf(r)].some((s) => EXECUTED.has(s)));
  const completed = recs.filter((r) => [...statusesOf(r)].some((s) => COMPLETED.has(s)));

  const metrics = {};
  metrics.decidedCount = ok(withOutcomes.length, { population });
  metrics.acceptanceRate = withOutcomes.length ? ok(round(accepted.length / population), { accepted: accepted.length, population }) : gap("no outcomes recorded for this group");
  metrics.executionRate = accepted.length ? ok(round(executed.length / accepted.length), { executed: executed.length, accepted: accepted.length }) : gap("no accepted recommendations to execute");
  metrics.completionRate = executed.length ? ok(round(completed.length / executed.length), { completed: completed.length, executed: executed.length }) : gap("no executed recommendations to complete");

  // time-to-action / time-to-outcome require recommendation creation timestamps.
  if (createdAtByRecommendation && withOutcomes.length) {
    const deltas = [];
    const outDeltas = [];
    for (const r of withOutcomes) {
      const created = createdAtByRecommendation[r.recommendationId];
      if (!created) continue;
      const outs = (outcomesByRec.get(r.recommendationId) || []).slice().sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
      const firstAction = outs.find((o) => ACCEPTED.has(o.status) || o.status === "rejected");
      const finalOutcome = outs[outs.length - 1];
      if (firstAction) deltas.push((new Date(firstAction.observedAt) - new Date(created)) / 3600000);
      if (finalOutcome) outDeltas.push((new Date(finalOutcome.observedAt) - new Date(created)) / 3600000);
    }
    metrics.timeToActionHours = deltas.length ? ok(round(deltas.reduce((a, b) => a + b, 0) / deltas.length, 2), { n: deltas.length }) : gap("no creation timestamps for decided recommendations");
    metrics.timeToOutcomeHours = outDeltas.length ? ok(round(outDeltas.reduce((a, b) => a + b, 0) / outDeltas.length, 2), { n: outDeltas.length }) : gap("no creation timestamps for outcomes");
  } else {
    metrics.timeToActionHours = gap("requires recommendation creation timestamps (not on the immutable record)");
    metrics.timeToOutcomeHours = gap("requires recommendation creation timestamps (not on the immutable record)");
  }

  // expected vs actual impact (only from outcomes that carry measured impact).
  const impacts = recs.flatMap((r) => (outcomesByRec.get(r.recommendationId) || [])).map((o) => o.impact).filter((i) => i && i.actual != null && i.expected != null);
  if (impacts.length) {
    const meanExpected = impacts.reduce((a, i) => a + Number(i.expected), 0) / impacts.length;
    const meanActual = impacts.reduce((a, i) => a + Number(i.actual), 0) / impacts.length;
    metrics.expectedImpact = ok(round(meanExpected), { n: impacts.length });
    metrics.actualImpact = ok(round(meanActual), { n: impacts.length });
    metrics.effectiveness = meanExpected ? ok(round(meanActual / meanExpected), { meanActual: round(meanActual), meanExpected: round(meanExpected) }) : gap("expected impact is zero");
  } else {
    metrics.expectedImpact = gap("no measured impact on outcomes");
    metrics.actualImpact = gap("no measured impact on outcomes");
    metrics.effectiveness = gap("no measured impact on outcomes");
  }
  return metrics;
}

/**
 * @param {object} p
 * @param {Array}  p.recommendations
 * @param {Array}  p.outcomes                        recommendation-kind outcomes
 * @param {string} [p.dimension]                     "type" | "workspace" | "project" | "team"
 * @param {object} [p.createdAtByRecommendation]     recommendationId -> ISO
 * @param {object} [p.dimensionByRecommendation]     recommendationId -> group key (overrides)
 * @returns {object} { dimension, groups:[{key, count, metrics}], overall }
 */
export function computeEffectiveness({ recommendations = [], outcomes = [], dimension = "type", createdAtByRecommendation = null, dimensionByRecommendation = null } = {}) {
  const recOutcomes = outcomes.filter((o) => (o.kind === "recommendation") || o.recommendationId || o.subjectId);
  const outcomesByRec = new Map();
  for (const o of recOutcomes) {
    const key = o.refs?.recommendationId || o.recommendationId || o.subjectId;
    if (!key) continue;
    if (!outcomesByRec.has(key)) outcomesByRec.set(key, []);
    outcomesByRec.get(key).push(o);
  }

  const groups = new Map();
  for (const r of recommendations) {
    const k = dimensionKey(r, dimension, dimensionByRecommendation);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const groupList = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, recs]) => ({ key, count: recs.length, metrics: groupMetrics(recs, outcomesByRec, createdAtByRecommendation) }));

  const overall = groupMetrics(recommendations, outcomesByRec, createdAtByRecommendation);
  return { dimension, groups: groupList, overall };
}
