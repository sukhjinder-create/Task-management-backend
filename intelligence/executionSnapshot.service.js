import pool from "../db.js";

/**
 * Unified execution reality snapshot
 * Used by health, scoring, intelligence
 */
export async function getExecutionSnapshot(workspaceId) {

  // internal tasks
  const internal = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status='completed') AS completed
    FROM tasks
    WHERE workspace_id=$1
  `, [workspaceId]);

  // external workload
  const externalTotal = await pool.query(`
    SELECT COUNT(*) AS total
    FROM integration_entity_state
    WHERE workspace_id=$1
  `, [workspaceId]);

  // external completions
  const externalCompleted = await pool.query(`
    SELECT COUNT(DISTINCT external_id) AS completed
    FROM workspace_execution_signals
    WHERE workspace_id=$1
      AND signal_type='INTEGRATION_TASK_COMPLETED'
  `, [workspaceId]);

  const totalWork =
    Number(internal.rows[0].total || 0) +
    Number(externalTotal.rows[0].total || 0);

  const completedWork =
    Number(internal.rows[0].completed || 0) +
    Number(externalCompleted.rows[0].completed || 0);

  const completionRate =
    totalWork === 0 ? 0 : completedWork / totalWork;

  return {
    totalWork,
    completedWork,
    completionRate
  };
}