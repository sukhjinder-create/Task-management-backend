// services/audit.service.js
// Enterprise audit log — write-only append log for compliance
import db from "../db.js";

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
  limit = 50,
  offset = 0,
}) {
  const conditions = ["al.workspace_id = $1"];
  const params = [workspaceId];
  let i = 2;

  if (userId) { conditions.push(`al.user_id = $${i++}`); params.push(userId); }
  if (action)  { conditions.push(`al.action ILIKE $${i++}`); params.push(`%${action}%`); }
  if (entityType) { conditions.push(`al.entity_type = $${i++}`); params.push(entityType); }
  if (entityId)   { conditions.push(`al.entity_id = $${i++}`); params.push(String(entityId)); }
  if (startDate)  { conditions.push(`al.created_at >= $${i++}`); params.push(startDate); }
  if (endDate)    { conditions.push(`al.created_at <= $${i++}`); params.push(endDate); }

  const where = conditions.join(" AND ");
  params.push(limit, offset);

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
    logs: rows.rows,
    total: parseInt(countRow.rows[0].count, 10),
    limit,
    offset,
  };
}
