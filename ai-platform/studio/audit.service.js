// ai-platform/studio/audit.service.js
//
// Epic C — audit logging (Contract §9). Every Studio mutation records an
// ai_audit_logs row (actor, action, object, before/after). buildAuditRecord is
// pure/testable; recordAudit is schema-tolerant (never throws).

import { q } from "./db.js";

export function buildAuditRecord({ actorType, actorId, action, objectType, objectKey, workspaceId = null, before = null, after = null }) {
  return {
    actorType: actorType || "system",
    actorId: actorId ?? null,
    action: action || "unknown",
    objectType: objectType || null,
    objectKey: objectKey ?? null,
    workspaceId: workspaceId ?? null,
    before: before ?? null,
    after: after ?? null,
    ts: new Date().toISOString(),
  };
}

export async function recordAudit(input) {
  const r = buildAuditRecord(input);
  await q(
    `INSERT INTO ai_audit_logs (actor_type, actor_id, action, object_type, object_key, workspace_id, before_json, after_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [r.actorType, r.actorId, r.action, r.objectType, r.objectKey, r.workspaceId,
     r.before ? JSON.stringify(r.before) : null, r.after ? JSON.stringify(r.after) : null]
  );
  return r;
}

export async function listAudit({ objectType = null, workspaceId = null, limit = 100 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ai_audit_logs
      WHERE ($1::text IS NULL OR object_type = $1)
        AND ($2::text IS NULL OR workspace_id = $2)
      ORDER BY ts DESC LIMIT $3`,
    [objectType, workspaceId, Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}
