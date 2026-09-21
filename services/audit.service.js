import crypto from "node:crypto";
import db from "../db.js";

function parseJsonValue(value) {
  if (value == null || typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function mapAuditRow(row) {
  return {
    ...row,
    old_value: parseJsonValue(row.old_value),
    new_value: parseJsonValue(row.new_value),
    metadata: parseJsonValue(row.metadata),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function auditHash(event) {
  return crypto.createHash("sha256").update(canonicalJson(event)).digest("hex");
}

function normalizedAudit(opts, createdAt = new Date()) {
  return {
    workspace_id: opts.workspaceId || null,
    user_id: opts.userId || null,
    action: String(opts.action || "unknown"),
    entity_type: opts.entityType || null,
    entity_id: opts.entityId == null ? null : String(opts.entityId),
    old_value: opts.oldValue ?? null,
    new_value: opts.newValue ?? null,
    ip_address: opts.ipAddress || null,
    user_agent: opts.userAgent || null,
    metadata: opts.metadata || {},
    created_at: createdAt.toISOString(),
  };
}

/** Write a chained audit event. Use this variant when audit evidence is part of the operation's contract. */
export async function logAuditRequired(opts, database = db) {
  if (!opts?.action) throw new Error("Audit action is required");
  const client = await database.connect();
  const createdAt = new Date();
  const event = normalizedAudit(opts, createdAt);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext(COALESCE($1, 'GLOBAL')))", [event.workspace_id]);
    const previous = await client.query(
      `SELECT chain_sequence, event_hash FROM audit_logs
        WHERE workspace_id IS NOT DISTINCT FROM $1 AND event_hash IS NOT NULL
        ORDER BY chain_sequence DESC LIMIT 1`,
      [event.workspace_id]
    );
    const sequence = Number(previous.rows[0]?.chain_sequence || 0) + 1;
    const previousHash = previous.rows[0]?.event_hash || null;
    const eventHash = auditHash({ sequence, previous_hash: previousHash, ...event });
    const inserted = await client.query(
      `INSERT INTO audit_logs
         (workspace_id, user_id, action, entity_type, entity_id,
          old_value, new_value, ip_address, user_agent, metadata, created_at,
          chain_sequence, previous_hash, event_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        event.workspace_id, event.user_id, event.action, event.entity_type, event.entity_id,
        event.old_value == null ? null : JSON.stringify(event.old_value),
        event.new_value == null ? null : JSON.stringify(event.new_value),
        event.ip_address, event.user_agent, JSON.stringify(event.metadata), createdAt,
        sequence, previousHash, eventHash,
      ]
    );
    await client.query("COMMIT");

    // Existing webhook infrastructure provides durable retry/replay for SIEM
    // consumers without coupling the primary action to an external service.
    if (event.workspace_id) {
      import("./webhook.service.js")
        .then(({ fireWebhooks }) => fireWebhooks(event.workspace_id, "audit.event", {
          ...event, chain_sequence: sequence, previous_hash: previousHash, event_hash: eventHash,
        }))
        .catch(() => {});
    }
    return mapAuditRow(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Rolling-deploy fallback while the additive chain columns are not present.
    if (error.code === "42703") {
      const inserted = await database.query(
        `INSERT INTO audit_logs
           (workspace_id, user_id, action, entity_type, entity_id,
            old_value, new_value, ip_address, user_agent, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [event.workspace_id, event.user_id, event.action, event.entity_type, event.entity_id,
         event.old_value == null ? null : JSON.stringify(event.old_value),
         event.new_value == null ? null : JSON.stringify(event.new_value),
         event.ip_address, event.user_agent, JSON.stringify(event.metadata), createdAt]
      );
      return mapAuditRow(inserted.rows[0]);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Best-effort compatibility wrapper for ordinary product telemetry. */
export async function logAudit(opts) {
  try {
    return await logAuditRequired(opts);
  } catch (error) {
    console.warn("[audit] Failed to write audit log:", error.message);
    return null;
  }
}

function auditFilters({ workspaceId, userId, action, entityType, entityId, startDate, endDate }) {
  const conditions = ["al.workspace_id = $1", "al.action != 'request.get'", "al.action NOT LIKE 'project.history.%'"];
  const params = [workspaceId];
  if (userId) { params.push(userId); conditions.push(`al.user_id = $${params.length}`); }
  if (action) { params.push(`%${action}%`); conditions.push(`al.action ILIKE $${params.length}`); }
  if (entityType) { params.push(entityType); conditions.push(`al.entity_type = $${params.length}`); }
  if (entityId) { params.push(String(entityId)); conditions.push(`al.entity_id = $${params.length}`); }
  if (startDate) { params.push(startDate); conditions.push(`al.created_at >= $${params.length}`); }
  if (endDate) { params.push(endDate); conditions.push(`al.created_at <= $${params.length}`); }
  return { where: conditions.join(" AND "), params };
}

export async function getAuditLogs(options) {
  const resolvedLimit = Math.min(Math.max(parseInt(options.pageSize ?? options.limit, 10) || 50, 1), 200);
  const resolvedPage = Math.max(parseInt(options.page, 10) || 1, 1);
  const resolvedOffset = options.page != null
    ? (resolvedPage - 1) * resolvedLimit
    : Math.max(parseInt(options.offset, 10) || 0, 0);
  const { where, params } = auditFilters(options);
  const [rows, countRow] = await Promise.all([
    db.query(
      `SELECT al.*, u.username, u.email FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ${where} ORDER BY al.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, resolvedLimit, resolvedOffset]
    ),
    db.query(`SELECT COUNT(*) FROM audit_logs al WHERE ${where}`, params),
  ]);
  const total = Number(countRow.rows[0].count);
  return { logs: rows.rows.map(mapAuditRow), total, limit: resolvedLimit, offset: resolvedOffset, page: resolvedPage, totalPages: Math.max(1, Math.ceil(total / resolvedLimit)) };
}

export async function exportAuditLogs(options, { limit = 50_000 } = {}) {
  const { where, params } = auditFilters(options);
  const result = await db.query(
    `SELECT al.*, u.username, u.email FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE ${where} ORDER BY al.created_at ASC LIMIT $${params.length + 1}`,
    [...params, Math.min(Math.max(Number(limit) || 50_000, 1), 50_000)]
  );
  return result.rows.map(mapAuditRow);
}

export async function verifyAuditChain(workspaceId, database = db) {
  const result = await database.query(
    `SELECT * FROM audit_logs WHERE workspace_id = $1 AND event_hash IS NOT NULL
      ORDER BY chain_sequence ASC`,
    [workspaceId]
  );
  let previousHash = null;
  let expectedSequence = 1;
  for (const raw of result.rows) {
    const row = mapAuditRow(raw);
    const event = normalizedAudit({
      workspaceId: row.workspace_id, userId: row.user_id, action: row.action,
      entityType: row.entity_type, entityId: row.entity_id,
      oldValue: row.old_value, newValue: row.new_value,
      ipAddress: row.ip_address, userAgent: row.user_agent, metadata: row.metadata,
    }, new Date(row.created_at));
    const expectedHash = auditHash({ sequence: expectedSequence, previous_hash: previousHash, ...event });
    if (Number(row.chain_sequence) !== expectedSequence || row.previous_hash !== previousHash || row.event_hash !== expectedHash) {
      return { valid: false, checked: expectedSequence - 1, failed_at: row.id };
    }
    previousHash = row.event_hash;
    expectedSequence += 1;
  }
  return { valid: true, checked: result.rows.length, head: previousHash };
}

export async function getProjectHistory({ workspaceId, projectId, page, pageSize, limit = 20, offset = 0 }) {
  const resolvedLimit = Math.min(Math.max(parseInt(pageSize ?? limit, 10) || 20, 1), 100);
  const resolvedPage = Math.max(parseInt(page, 10) || 1, 1);
  const resolvedOffset = page != null ? (resolvedPage - 1) * resolvedLimit : Math.max(parseInt(offset, 10) || 0, 0);
  const historyWhere = `al.workspace_id = $1 AND al.action LIKE 'project.history.%' AND
    ((al.entity_type = 'project' AND al.entity_id = $2) OR (al.metadata->>'projectId') = $2)`;
  const [rows, countRow] = await Promise.all([
    db.query(
      `SELECT al.*, u.username, u.email FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
       WHERE ${historyWhere} ORDER BY al.created_at DESC LIMIT $3 OFFSET $4`,
      [workspaceId, String(projectId), resolvedLimit, resolvedOffset]
    ),
    db.query(`SELECT COUNT(*) FROM audit_logs al WHERE ${historyWhere}`, [workspaceId, String(projectId)]),
  ]);
  const total = Number(countRow.rows[0].count);
  return { logs: rows.rows.map(mapAuditRow), total, limit: resolvedLimit, offset: resolvedOffset, page: resolvedPage, totalPages: Math.max(1, Math.ceil(total / resolvedLimit)) };
}

export const __testables = { canonicalJson, auditHash, normalizedAudit };
