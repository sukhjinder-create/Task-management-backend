// services/audit.service.js
// Enterprise audit log — write-only append log for compliance
import db from "../db.js";

function parseJsonValue(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapAuditRow(row) {
  return {
    ...row,
    old_value: parseJsonValue(row.old_value),
    new_value: parseJsonValue(row.new_value),
    metadata: parseJsonValue(row.metadata),
  };
}

/**
 * Log an auditable action.
 * Never throws — audit logging must never break the main request flow.
 *
 * @param {Object} opts
 * @param {string} opts.workspaceId
 * @param {string} [opts.userId]
 * @param {string} opts.action          e.g. 'task.create', 'user.login', 'role.change'
 * @param {string} [opts.entityType]    e.g. 'task', 'project', 'user'
 * @param {string} [opts.entityId]
 * @param {any}    [opts.oldValue]
 * @param {any}    [opts.newValue]
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.userAgent]
 * @param {Object} [opts.metadata]
 */
export async function logAudit(opts) {
  try {
    const {
      workspaceId, userId, action, entityType, entityId,
      oldValue, newValue, ipAddress, userAgent, metadata = {},
    } = opts;

    await db.query(
      `INSERT INTO audit_logs
         (workspace_id, user_id, action, entity_type, entity_id,
          old_value, new_value, ip_address, user_agent, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        workspaceId || null,
        userId || null,
        action,
        entityType || null,
        entityId ? String(entityId) : null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        ipAddress || null,
        userAgent || null,
        JSON.stringify(metadata),
      ]
    );
  } catch (err) {
    // Never crash the caller
    console.warn("[audit] Failed to write audit log:", err.message);
  }
}

/**
 * Query audit logs with filters.
 */
export async function getAuditLogs({
  workspaceId,
  userId,
  action,
  entityType,
  entityId,
  startDate,
  endDate,
  page,
  pageSize,
  limit = 50,
  offset = 0,
}) {
  const resolvedLimit = Math.min(
    Math.max(parseInt(pageSize ?? limit, 10) || 50, 1),
    200
  );
  const resolvedPage = Math.max(parseInt(page, 10) || 1, 1);
  const resolvedOffset =
    page != null ? (resolvedPage - 1) * resolvedLimit : Math.max(parseInt(offset, 10) || 0, 0);

  const conditions = [
    "al.workspace_id = $1",
    // Hide raw HTTP-read noise; write operations have semantic names (e.g. task.create)
    "al.action != 'request.get'",
    "al.action NOT LIKE 'project.history.%'",
  ];
  const params = [workspaceId];
  let i = 2;

  if (userId) { conditions.push(`al.user_id = $${i++}`); params.push(userId); }
  if (action)  { conditions.push(`al.action ILIKE $${i++}`); params.push(`%${action}%`); }
  if (entityType) { conditions.push(`al.entity_type = $${i++}`); params.push(entityType); }
  if (entityId)   { conditions.push(`al.entity_id = $${i++}`); params.push(String(entityId)); }
  if (startDate)  { conditions.push(`al.created_at >= $${i++}`); params.push(startDate); }
  if (endDate)    { conditions.push(`al.created_at <= $${i++}`); params.push(endDate); }

  const where = conditions.join(" AND ");
  params.push(resolvedLimit, resolvedOffset);

  const [rows, countRow] = await Promise.all([
    db.query(
      `SELECT al.*, u.username, u.email
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ${where}
       ORDER BY al.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    ),
    db.query(
      `SELECT COUNT(*) FROM audit_logs al WHERE ${where}`,
      params.slice(0, -2)
    ),
  ]);

  return {
    logs: rows.rows.map(mapAuditRow),
    total: parseInt(countRow.rows[0].count, 10),
    limit: resolvedLimit,
    offset: resolvedOffset,
    page: resolvedPage,
    totalPages: Math.max(1, Math.ceil(parseInt(countRow.rows[0].count, 10) / resolvedLimit)),
  };
}

export async function getProjectHistory({
  workspaceId,
  projectId,
  page,
  pageSize,
  limit = 20,
  offset = 0,
}) {
  const resolvedLimit = Math.min(
    Math.max(parseInt(pageSize ?? limit, 10) || 20, 1),
    100
  );
  const resolvedPage = Math.max(parseInt(page, 10) || 1, 1);
  const resolvedOffset =
    page != null ? (resolvedPage - 1) * resolvedLimit : Math.max(parseInt(offset, 10) || 0, 0);

  const params = [workspaceId, String(projectId), resolvedLimit, resolvedOffset];
  const historyWhere = `
    al.workspace_id = $1
    AND al.action LIKE 'project.history.%'
    AND (
      (al.entity_type = 'project' AND al.entity_id = $2)
      OR (al.metadata->>'projectId') = $2
    )
  `;

  const [rows, countRow] = await Promise.all([
    db.query(
      `SELECT al.*, u.username, u.email
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ${historyWhere}
       ORDER BY al.created_at DESC
       LIMIT $3 OFFSET $4`,
      params
    ),
    db.query(
      `SELECT COUNT(*) FROM audit_logs al WHERE ${historyWhere}`,
      params.slice(0, 2)
    ),
  ]);

  const total = parseInt(countRow.rows[0].count, 10);

  return {
    logs: rows.rows.map(mapAuditRow),
    total,
    limit: resolvedLimit,
    offset: resolvedOffset,
    page: resolvedPage,
    totalPages: Math.max(1, Math.ceil(total / resolvedLimit)),
  };
}
