// ei/evidence/evidence.js
//
// EI V2.1 Phase 3 — the immutable Evidence Layer. Evidence is NOT attribution: it
// is a normalized, immutable, provenance-carrying record that ties an attribution
// to its supporting/contradicting event evidence, and supports invalidation by
// SUPERSESSION (a new evidence revision when the underlying events change — no
// in-place mutation). Deterministic, replay-safe, no LLM. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const EVIDENCE_SCHEMA_VERSION = 1;

/** Deterministic id: same attribution + same input hash → same evidence id (idempotent). */
export function deriveEvidenceId(attributionId, inputHash) {
  return "evd_" + createHash("sha256").update(`${attributionId}|${inputHash || ""}`).digest("hex").slice(0, 40);
}

/**
 * Project an attribution (Phase 2) into an immutable evidence record.
 * @returns {object|null}
 */
export function fromAttribution(attribution) {
  if (!attribution || !attribution.attributionId || !attribution.workspaceId) return null;
  const inputHash = attribution.provenance?.inputHash || "";
  return deepFreeze({
    evidenceId: deriveEvidenceId(attribution.attributionId, inputHash),
    eiVersion: "2.1",
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    workspaceId: attribution.workspaceId,
    entity: attribution.effect?.entity || { type: null, id: null },
    attributionRef: { attributionId: attribution.attributionId, tier: attribution.tier, ruleKey: attribution.ruleKey },
    supportingEvidence: attribution.supportingEvidence || [],   // event refs
    contradictingEvidence: attribution.contradictingEvidence || [],
    confidenceSource: attribution.confidenceSource,             // observation | association | experiment
    temporalValidity: attribution.temporalValidity || { from: null, to: null },
    provenance: {
      sourceAttributionId: attribution.attributionId,
      sourceEventIds: attribution.provenance?.sourceEventIds || [],
      engineVersion: "ei-evd-1",
      inputHash,
    },
    // Current evidence for an attribution = the latest revision by this key.
    revisionKey: attribution.attributionId,
  });
}

/** @returns {{ok:boolean, errors:string[]}} */
export function validateEvidence(e) {
  const errors = [];
  if (!e || typeof e !== "object") return { ok: false, errors: ["evidence_must_be_object"] };
  if (!e.evidenceId) errors.push("missing_evidenceId");
  if (!e.workspaceId) errors.push("missing_workspaceId");
  if (!e.attributionRef?.attributionId) errors.push("missing_attributionRef");
  if (!Array.isArray(e.supportingEvidence)) errors.push("supportingEvidence_must_be_array");
  if (!e.confidenceSource) errors.push("missing_confidenceSource");
  if (!e.temporalValidity) errors.push("missing_temporalValidity");
  return { ok: errors.length === 0, errors };
}
