// ei/outcomes/outcome.js
//
// EI V2.1 Wave C — the immutable Outcomes Ledger record. An outcome is the ground
// truth that closes the loop: what actually happened to a recommendation or a
// prediction. Outcomes are NEW data (they do not exist upstream), which is why the
// ledger is the only genuinely new store in this wave. Append-only, no mutable
// updates: a correction is a NEW outcome, never an edit. Deterministic, versioned,
// no LLM. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const OUTCOME_SCHEMA_VERSION = 1;

export const OUTCOME_KIND = Object.freeze({ RECOMMENDATION: "recommendation", PREDICTION: "prediction" });

/** Terminal-or-interim states a recommendation can reach. */
export const REC_OUTCOME = Object.freeze(["accepted", "rejected", "executed", "partially_executed", "cancelled", "expired"]);
/** States a prediction can be validated into. */
export const PRED_OUTCOME = Object.freeze(["confirmed", "partially_confirmed", "refuted", "unknown"]);

const VALID = { [OUTCOME_KIND.RECOMMENDATION]: new Set(REC_OUTCOME), [OUTCOME_KIND.PREDICTION]: new Set(PRED_OUTCOME) };

/** Deterministic id: same (subject, status, time, actor) is the same recorded fact (idempotent). */
export function deriveOutcomeId({ workspaceId, kind, subjectId, status, observedAt, actorId }) {
  const salient = JSON.stringify([workspaceId, kind, subjectId, status, observedAt, actorId ?? null]);
  return "out_" + createHash("sha256").update(salient).digest("hex").slice(0, 40);
}

/**
 * @param {object} f
 * @param {string} f.workspaceId
 * @param {string} f.kind        OUTCOME_KIND.*
 * @param {string} f.status      a valid status for the kind
 * @param {object} f.refs        { recommendationId?, predictionId?, traceId?, evidenceIds?[], attributionIds?[] }
 * @param {string} f.observedAt  ISO timestamp the outcome was observed
 * @param {object} [f.actor]     { type, id }
 * @param {object} [f.impact]    { expected?, actual?, unit? } — optional measured impact
 * @returns {object|null} frozen outcome
 */
export function createOutcome(f) {
  const { workspaceId, kind, status, refs = {}, observedAt, actor = null, impact = null, provenance = {} } = f || {};
  const subjectId = kind === OUTCOME_KIND.RECOMMENDATION ? refs.recommendationId : refs.predictionId;
  if (!workspaceId || !VALID[kind] || !subjectId || !VALID[kind].has(status) || !observedAt) return null;
  return deepFreeze({
    outcomeId: deriveOutcomeId({ workspaceId, kind, subjectId, status, observedAt, actorId: actor?.id }),
    eiVersion: "2.1",
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    kind,
    status,
    subjectId,
    refs: {
      recommendationId: refs.recommendationId ?? null,
      predictionId: refs.predictionId ?? null,
      traceId: refs.traceId ?? null,
      evidenceIds: refs.evidenceIds || [],
      attributionIds: refs.attributionIds || [],
    },
    observedAt,
    actor,                                   // who/what reported it (append-only audit)
    impact,                                  // { expected, actual, unit } | null
    provenance: { engineVersion: "ei-out-1", ...provenance },
  });
}

export function validateOutcome(o) {
  const errors = [];
  if (!o || typeof o !== "object") return { ok: false, errors: ["outcome_must_be_object"] };
  if (!o.outcomeId) errors.push("missing_outcomeId");
  if (!o.workspaceId) errors.push("missing_workspaceId");
  if (!VALID[o.kind]) errors.push("invalid_kind");
  if (o.kind && VALID[o.kind] && !VALID[o.kind].has(o.status)) errors.push("invalid_status_for_kind");
  if (!o.subjectId) errors.push("missing_subject_ref");        // must reference a recommendation or prediction
  if (!o.observedAt) errors.push("missing_observedAt");
  return { ok: errors.length === 0, errors };
}
