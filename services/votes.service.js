import pool from "../db.js";

export async function getVotes({ taskId }) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM task_votes WHERE task_id = $1`,
    [taskId]
  );
  return rows[0].count;
}

export async function hasVoted({ taskId, userId }) {
  const { rows } = await pool.query(
    `SELECT 1 FROM task_votes WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return rows.length > 0;
}

export async function toggleVote({ taskId, userId, workspaceId }) {
  const voted = await hasVoted({ taskId, userId });
  if (voted) {
    await pool.query(
      `DELETE FROM task_votes WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId]
    );
  } else {
    await pool.query(
      `INSERT INTO task_votes (task_id, user_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [taskId, userId, workspaceId]
    );
  }
  const count = await getVotes({ taskId });
  return { voted: !voted, count };
}
