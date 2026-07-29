// ei/outcomes/store.js
//
// EI V2.1 Wave C — immutable Outcomes Ledger store. Append-only, idempotent by
// outcome_id, versioned. No UPDATE path (corrections are new rows). Schema-tolerant.
// UNVERIFIED AT RUNTIME (needs a migrated database). Reuses the AI Platform q.

import { q } from "../../ai-platform/studio/db.js";

export async function appendOutcome(o) {
  if (!o || !o.outcomeId || !o.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_outcomes
       (outcome_id, workspace_id, kind, status, subject_id, refs_json,
        observed_at, actor_json, impact_json, provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (outcome_id) DO NOTHING
     RETURNING outcome_id`,
    [
      o.outcomeId, o.workspaceId, o.kind, o.status, o.subjectId, JSON.stringify(o.refs || {}),
      o.observedAt, JSON.stringify(o.actor ?? null), JSON.stringify(o.impact ?? null),
      JSON.stringify(o.provenance || {}), o.schemaVersion || 1,
    ]
  );
  return rows[0]?.outcome_id ?? null;
}

export async function listOutcomes({ workspaceId, kind = null, subjectId = null, limit = 1000 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_outcomes
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR kind = $2)
         AND ($3::text IS NULL OR subject_id = $3)
      ORDER BY observed_at, outcome_id
      LIMIT $4`,
    [workspaceId, kind, subjectId, Math.min(Number(limit) || 1000, 5000)]
  );
  return rows;
}
