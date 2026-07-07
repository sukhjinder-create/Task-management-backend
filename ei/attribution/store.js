// ei/attribution/store.js
//
// EI V2.1 §5′ — immutable attribution store. Append-only, idempotent by
// attribution_id (deterministic id → replay-safe). Schema-tolerant (no DB / no
// table → no-op/empty, never throws). Reuses the AI Platform schema-tolerant q.
// UNVERIFIED AT RUNTIME (needs a migrated database).

import { q } from "../../ai-platform/studio/db.js";

export async function appendAttribution(a) {
  if (!a || !a.attributionId || !a.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_attributions
       (attribution_id, workspace_id, rule_key, tier, language,
        effect_json, factor_json, association_strength, confidence_low, confidence_high,
        confidence_source, supporting_json, contradicting_json, confounders_json,
        identification_json, temporal_from, temporal_to, provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (attribution_id) DO NOTHING
     RETURNING attribution_id`,
    [
      a.attributionId, a.workspaceId, a.ruleKey, a.tier, a.language,
      JSON.stringify(a.effect || {}), JSON.stringify(a.factor || {}),
      a.associationStrength, a.confidenceInterval?.low ?? null, a.confidenceInterval?.high ?? null,
      a.confidenceSource, JSON.stringify(a.supportingEvidence || []), JSON.stringify(a.contradictingEvidence || []),
      JSON.stringify(a.recordedConfounders || []), a.identificationStrategy ? JSON.stringify(a.identificationStrategy) : null,
      a.temporalValidity?.from ?? null, a.temporalValidity?.to ?? null,
      JSON.stringify(a.provenance || {}), a.schemaVersion || 1,
    ]
  );
  return rows[0]?.attribution_id ?? null; // null → idempotent duplicate
}

export async function listAttributions({ workspaceId, tier = null, ruleKey = null, limit = 200 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_attributions
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR tier = $2)
        AND ($3::text IS NULL OR rule_key = $3)
      ORDER BY attribution_id LIMIT $4`,
    [workspaceId, tier, ruleKey, Math.min(Number(limit) || 200, 1000)]
  );
  return rows;
}
