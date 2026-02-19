import pool from "../db.js";

export async function recomputeWorkspaceHealth(workspaceId) {

  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed
    FROM tasks
    WHERE workspace_id = $1
  `, [workspaceId]);

  const total = Number(rows[0].total) || 0;
  const completed = Number(rows[0].completed) || 0;

  let healthScore = 70;

  if (total > 0) {
    healthScore = Math.round((completed / total) * 100);
  }

  const result = await pool.query(`
    INSERT INTO workspace_health (workspace_id, health_score)
    VALUES ($1, $2)
    ON CONFLICT (workspace_id)
    DO UPDATE SET
      health_score = EXCLUDED.health_score,
      updated_at = NOW()
    RETURNING health_score
  `, [workspaceId, healthScore]);

  return result.rows[0].health_score;
}
