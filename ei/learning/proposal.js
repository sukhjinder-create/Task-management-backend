// ei/learning/proposal.js
//
// EI V2.1 Wave C — the immutable Learning Proposal. Learning in this platform is
// PROPOSE-ONLY: the engine never mutates a weight, catalog, or model. It emits a
// versioned, auditable proposal about an EXISTING declared config value, references
// the verified outcomes that justify it, and records whether the evidence is confounded
// by an intervention (and thus admissible only under a holdout/control). Nothing here
// auto-publishes. Deterministic, no LLM. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const LEARNING_SCHEMA_VERSION = 1;

// Proposals may only target EXISTING, declared config (never opaque learned weights).
export const LEARNING_KIND = Object.freeze(["calibration_adoption", "catalog_min_probability", "recommendation_policy_weight", "attribution_rule_confidence"]);

export function createLearningProposal(f) {
  const {
    workspaceId, kind, target, currentValue = null, proposedValue = null,
    rationaleRefs = {}, evidence = {}, cleanliness = {}, version = 1, provenance = {},
  } = f || {};
  const outcomeIds = (rationaleRefs.outcomeIds || []).slice().sort();
  const admissible = !cleanliness.confounded || Boolean(evidence.holdout);
  return deepFreeze({
    proposalId: "lp_" + createHash("sha256").update(JSON.stringify([workspaceId, kind, target, version, outcomeIds])).digest("hex").slice(0, 40),
    eiVersion: "2.1",
    schemaVersion: LEARNING_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    kind,
    target,                                  // the existing config key this would change
    currentValue,
    proposedValue,
    rationaleRefs: {
      outcomeIds,
      predictionIds: (rationaleRefs.predictionIds || []).slice().sort(),
      recommendationIds: (rationaleRefs.recommendationIds || []).slice().sort(),
      experimentId: rationaleRefs.experimentId ?? null,
    },
    evidence: {                              // uplift / holdout / counterfactual / sample size
      sampleSize: evidence.sampleSize ?? 0,
      uplift: evidence.uplift ?? null,
      holdout: Boolean(evidence.holdout),
      counterfactual: evidence.counterfactual ?? null,
    },
    cleanliness: { confounded: Boolean(cleanliness.confounded), reason: cleanliness.reason ?? null },
    admissible,                              // confounded evidence is admissible only with a holdout
    status: admissible ? "candidate" : "blocked_confounded",
    version,
    provenance: { engineVersion: "ei-learn-1", ...provenance },
  });
}

export function validateLearningProposal(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["proposal_must_be_object"] };
  if (!p.proposalId) errors.push("missing_proposalId");
  if (!LEARNING_KIND.includes(p.kind)) errors.push("invalid_kind");
  if (!p.target) errors.push("missing_target");
  if (!(p.evidence?.sampleSize > 0)) errors.push("evidence_sample_size_required");
  if ((p.rationaleRefs?.outcomeIds || []).length === 0) errors.push("must_reference_verified_outcomes"); // learn ONLY from outcomes
  if (p.cleanliness?.confounded && !p.evidence?.holdout) errors.push("confounded_evidence_requires_holdout"); // constitutional guard
  return { ok: errors.length === 0, errors };
}
