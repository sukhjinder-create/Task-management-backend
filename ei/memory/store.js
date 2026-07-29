// ei/memory/store.js
//
// EI V2.1 Wave C — immutable, versioned organizational-memory store. Append-only,
// idempotent by memory_id. Current knowledge = latest version per revision_key
// (older versions retained → replayable). Schema-tolerant. UNVERIFIED AT RUNTIME.

import { q } from "../../ai-platform/studio/db.js";

export async function appendMemory(m) {
  if (!m || !m.memoryId || !m.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_org_memory
       (memory_id, workspace_id, kind, key, revision_key, version, value_json, support_json, valid_from, provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (memory_id) DO NOTHING
     RETURNING memory_id`,
    [
      m.memoryId, m.workspaceId, m.kind, m.key, m.revisionKey, m.version,
      JSON.stringify(m.value || {}), JSON.stringify(m.support || {}), m.validFrom,
      JSON.stringify(m.provenance || {}), m.schemaVersion || 1,
    ]
  );
  return rows[0]?.memory_id ?? null;
}

/** Current memory = latest version per revision_key. */
export async function listCurrentMemory({ workspaceId, kind = null, limit = 500 } = {}) {
  const { rows } = await q(
    `SELECT DISTINCT ON (revision_key) *
       FROM ei_org_memory
      WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY revision_key, version DESC
      LIMIT $3`,
    [workspaceId, kind, Math.min(Number(limit) || 500, 2000)]
  );
  return rows;
}
