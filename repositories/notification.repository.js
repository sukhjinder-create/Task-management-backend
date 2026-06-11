import pool from "../db.js";

export async function createNotification({
  user_id,
  type,
  message,
  title = null,
  action_url = null,
  source_key = null,
  metadata = {},
  task_id = null,
  project_id = null,
  comment_id = null,
  workspaceId = null,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO notifications (
      user_id,
      type,
      message,
      task_id,
      project_id,
      comment_id,
      workspace_id,
      title,
      action_url,
      source_key,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (user_id, source_key)
    WHERE source_key IS NOT NULL
    DO UPDATE SET
      type = EXCLUDED.type,
      message = EXCLUDED.message,
      title = EXCLUDED.title,
      action_url = EXCLUDED.action_url,
      metadata = notifications.metadata || EXCLUDED.metadata,
      workspace_id = EXCLUDED.workspace_id
    RETURNING *
    `,
    [
      user_id,
      type,
      message,
      task_id,
      project_id,
      comment_id,
      workspaceId || null,
      title,
      action_url,
      source_key,
      JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
    ]
  );
  return rows[0];
}

export async function getNotificationsByUser(
  userId,
  { unreadOnly = false, workspaceId = null } = {}
) {
  let query = `
    SELECT *
    FROM notifications
    WHERE user_id = $1
  `;
  const values = [userId];

  if (workspaceId) {
    query += ` AND workspace_id = $2`;
    values.push(workspaceId);
  }
  if (unreadOnly) query += " AND is_read = FALSE";
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
