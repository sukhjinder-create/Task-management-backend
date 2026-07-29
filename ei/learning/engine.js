// ei/learning/engine.js
//
// EI V2.1 Wave C — the Learning Engine. Generates learning PROPOSALS (never mutations)
// strictly from VERIFIED outcomes, and enforces the constitutional confounding guard:
// a prediction outcome that an executed recommendation may have changed is confounded,
// and is admissible for learning only when a holdout/control experiment covers it.
// Deterministic, no LLM.

import { createLearningProposal } from "./proposal.js";

const VERIFIED_PRED = new Set(["confirmed", "refuted", "partially_confirmed"]);
const EXECUTED_REC = new Set(["executed", "partially_executed"]);

/**
 * @param {object} p { workspaceId, recommendations, predictions, outcomes, validation, effectiveness, experiments }
 * @returns {object[]} deterministic proposals
 */
export function generateProposals({ workspaceId, recommendations = [], predictions = [], outcomes = [], validation = null, effectiveness = null, experiments = [] } = {}) {
  const predOutcomes = outcomes.filter((o) => o.kind === "prediction" || o.refs?.predictionId);
  const recOutcomes = outcomes.filter((o) => o.kind === "recommendation" || o.refs?.recommendationId);

  const verifiedPred = predOutcomes.filter((o) => VERIFIED_PRED.has(o.status));
  const verifiedOutcomeIds = verifiedPred.map((o) => o.outcomeId).filter(Boolean);

  // Which predictions were possibly changed by an EXECUTED recommendation → confounded.
  const executedPredIds = new Set();
  const recByPred = new Map();
  for (const r of recommendations) if (r.rationaleRefs?.predictionId) recByPred.set(r.rationaleRefs.predictionId, r);
  const recExecuted = new Set(recOutcomes.filter((o) => EXECUTED_REC.has(o.status)).map((o) => o.refs?.recommendationId || o.subjectId));
  for (const [predId, r] of recByPred.entries()) if (recExecuted.has(r.recommendationId)) executedPredIds.add(predId);

  const confoundedCount = verifiedPred.filter((o) => executedPredIds.has(o.refs?.predictionId || o.subjectId)).length;
  const confounded = confoundedCount > 0;
  const holdoutExists = (experiments || []).some((x) => x.design === "holdout");

  const proposals = [];

  // (1) Calibration adoption — when validated predictions are miscalibrated.
  const calQ = validation?.metrics?.calibrationQuality;
  if (calQ?.evidenceSufficient && calQ.value < 0.9 && verifiedOutcomeIds.length > 0) {
    proposals.push(createLearningProposal({
      workspaceId, kind: "calibration_adoption", target: "prediction.confidence_source",
      currentValue: "raw", proposedValue: "calibrated",
      rationaleRefs: { outcomeIds: verifiedOutcomeIds, predictionIds: verifiedPred.map((o) => o.refs?.predictionId).filter(Boolean) },
      evidence: { sampleSize: validation.metrics.evaluated?.value ?? verifiedOutcomeIds.length, uplift: Math.round((0.9 - calQ.value) * 1e4) / 1e4, holdout: holdoutExists, counterfactual: null },
      cleanliness: { confounded, reason: confounded ? `${confoundedCount} validated predictions had an executed recommendation (intervention may have changed the outcome)` : null },
    }));
  }

  // (2) Catalog minProbability — recommendation groups that underperform expectations.
  for (const g of effectiveness?.groups || []) {
    const eff = g.metrics?.effectiveness;
    if (eff?.evidenceSufficient && eff.value < 1) {
      const groupRecIds = recommendations.filter((r) => r.recommendationType === g.key).map((r) => r.recommendationId);
      const groupOutcomeIds = recOutcomes.filter((o) => groupRecIds.includes(o.refs?.recommendationId || o.subjectId)).map((o) => o.outcomeId).filter(Boolean);
      if (groupOutcomeIds.length === 0) continue;
      proposals.push(createLearningProposal({
        workspaceId, kind: "catalog_min_probability", target: `catalog.${g.key}.minProbability`,
        currentValue: null, proposedValue: "increase",
        rationaleRefs: { outcomeIds: groupOutcomeIds, recommendationIds: groupRecIds },
        evidence: { sampleSize: g.count, uplift: Math.round((eff.value - 1) * 1e4) / 1e4, holdout: holdoutExists, counterfactual: null },
        cleanliness: { confounded: false, reason: null }, // effectiveness is measured on the recommendations themselves
      }));
    }
  }

  return proposals.sort((a, b) => a.proposalId.localeCompare(b.proposalId));
}
