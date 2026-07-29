// ei/recommendation/store.js
//
// EI V2.1 Phase 6 — immutable recommendation store. Append-only, idempotent by
// recommendation_id, versioned. Schema-tolerant. UNVERIFIED AT RUNTIME (needs a
// migrated database). Reuses the AI Platform q.

import { q } from "../../ai-platform/studio/db.js";

export async function appendRecommendation(r) {
  if (!r || !r.recommendationId || !r.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_recommendations
       (recommendation_id, workspace_id, entity_json, recommendation_type, status,
        action_json, rationale_refs_json, alternatives_json, uncertainty_json,
        requires_approval, approval_scope_json, manual_only, assumptions_json,
        unknown_factors_json, explanation_json, provenance_json, schema_version, engine_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (recommendation_id) DO NOTHING
     RETURNING recommendation_id`,
    [
      r.recommendationId, r.workspaceId, JSON.stringify(r.entity || {}), r.recommendationType, r.status,
      JSON.stringify(r.action ?? null), JSON.stringify(r.rationaleRefs || {}), JSON.stringify(r.alternatives || []),
      JSON.stringify(r.uncertainty || {}), Boolean(r.requiresApproval), JSON.stringify(r.approvalScope ?? null),
      Boolean(r.manualOnly), JSON.stringify(r.assumptions || []), JSON.stringify(r.unknownFactors || {}),
      JSON.stringify(r.explanation || {}), JSON.stringify(r.provenance || {}),
      r.schemaVersion || 1, r.provenance?.engineVersion || null,
    ]
  );
  return rows[0]?.recommendation_id ?? null;
}

export async function listRecommendations({ workspaceId, status = null, limit = 200 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_recommendations
       WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY recommendation_id LIMIT $3`,
    [workspaceId, status, Math.min(Number(limit) || 200, 1000)]
  );
  return rows;
}
