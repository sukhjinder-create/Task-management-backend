// repositories/notification.repository.js 
import pool from "../db.js";

export async function createNotification({
  user_id,
  type,
  message,
  task_id = null,
  project_id = null,
  comment_id = null,
}) {
  const query = `
    INSERT INTO notifications (user_id, type, message, task_id, project_id, comment_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;
  const values = [user_id, type, message, task_id, project_id, comment_id];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function getNotificationsByUser(
  userId,
  { unreadOnly = false } = {}
) {
  let query = `
    SELECT *
    FROM notifications
    WHERE user_id = $1
  `;
  const values = [userId];

  if (unreadOnly) {
    query += " AND is_read = FALSE";
  }

  query += " ORDER BY created_at DESC LIMIT 100";

  const { rows } = await pool.query(query, values);
  return rows;
}

export async function markNotificationRead(id, userId) {
  const query = `
    UPDATE notifications
    SET is_read = TRUE
    WHERE id = $1 AND user_id = $2
    RETURNING *;
  `;
  const values = [id, userId];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function markAllNotificationsRead(userId) {
  const query = `
    UPDATE notifications
    SET is_read = TRUE
    WHERE user_id = $1 AND is_read = FALSE;
  `;
  await pool.query(query, [userId]);
}
