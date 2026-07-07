// ei/evidence/store.js
//
// EI V2.1 Phase 3 — immutable evidence store. Append-only, idempotent by
// evidence_id. Invalidation = supersession (the latest revision per revision_key
// is "current"; older revisions are retained but superseded). Schema-tolerant.
// UNVERIFIED AT RUNTIME (needs a migrated database). Reuses the AI Platform q.

import { q } from "../../ai-platform/studio/db.js";

export async function appendEvidence(e) {
  if (!e || !e.evidenceId || !e.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_evidence
       (evidence_id, workspace_id, revision_key, entity_json, attribution_ref_json,
        supporting_json, contradicting_json, confidence_source, temporal_from, temporal_to,
        provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (evidence_id) DO NOTHING
     RETURNING evidence_id`,
    [
      e.evidenceId, e.workspaceId, e.revisionKey, JSON.stringify(e.entity || {}),
      JSON.stringify(e.attributionRef || {}), JSON.stringify(e.supportingEvidence || []),
      JSON.stringify(e.contradictingEvidence || []), e.confidenceSource,
      e.temporalValidity?.from ?? null, e.temporalValidity?.to ?? null,
      JSON.stringify(e.provenance || {}), e.schemaVersion || 1,
    ]
  );
  return rows[0]?.evidence_id ?? null;
}

/** Current (non-superseded) evidence = latest revision per revision_key. */
export async function listCurrentEvidence({ workspaceId, limit = 500 } = {}) {
  const { rows } = await q(
    `SELECT DISTINCT ON (revision_key) *
       FROM ei_evidence WHERE workspace_id = $1
      ORDER BY revision_key, recorded_at DESC
      LIMIT $2`,
    [workspaceId, Math.min(Number(limit) || 500, 2000)]
  );
  return rows;
}
