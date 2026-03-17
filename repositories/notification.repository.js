import pool from "../db.js";

/**
 * NOTE:
 * - workspace_id in DB is UUID or NULL
 * - "GLOBAL" must NEVER be sent to Postgres
 * - Global notifications = workspace_id IS NULL
 */

export async function createNotification({
  user_id,
  type,
  message,
  task_id = null,
  project_id = null,
  comment_id = null,
  workspaceId = null, // ✅ CHANGED: default NULL, not "GLOBAL"
}) {
  const query = `
    INSERT INTO notifications (
      user_id,
      type,
      message,
      task_id,
      project_id,
      comment_id,
      workspace_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;

  const values = [
    user_id,
    type,
    message,
    task_id,
    project_id,
    comment_id,
    workspaceId || null, // ✅ ENSURE UUID or NULL ONLY
  ];

  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function getNotificationsByUser(
  userId,
  { unreadOnly = false, workspaceId = null } = {} // ✅ default NULL
) {
  let query = `
    SELECT *
    FROM notifications
    WHERE user_id = $1
  `;

  const values = [userId];

  // Filter by workspace when provided; otherwise return all for this user
  if (workspaceId) {
    query += ` AND workspace_id = $2`;
    values.push(workspaceId);
  }

  if (unreadOnly) {
    query += " AND is_read = FALSE";
  }

  query += " ORDER BY created_at DESC LIMIT 100";

  const { rows } = await pool.query(query, values);
  return rows;
}

export async function markNotificationRead(id, userId) {
  const { rows } = await pool.query(
    `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId]
  );
  return rows[0];
}

export async function markAllNotificationsRead(userId) {
  await pool.query(
    `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
    [userId]
  );
}
