import pool from "../db.js";

export async function getWatchers({ taskId }) {
  const { rows } = await pool.query(
    `SELECT tw.user_id, u.username AS name, u.email
     FROM task_watchers tw
     JOIN users u ON u.id = tw.user_id
     WHERE tw.task_id = $1
     ORDER BY u.username ASC`,
    [taskId]
  );
  return rows;
}

export async function isWatching({ taskId, userId }) {
  const { rows } = await pool.query(
    `SELECT 1 FROM task_watchers WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return rows.length > 0;
}

export async function watchTask({ taskId, userId, workspaceId }) {
  await pool.query(
    `INSERT INTO task_watchers (task_id, user_id, workspace_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [taskId, userId, workspaceId]
  );
  return getWatchers({ taskId });
}

export async function unwatchTask({ taskId, userId }) {
  await pool.query(
    `DELETE FROM task_watchers WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return getWatchers({ taskId });
}
