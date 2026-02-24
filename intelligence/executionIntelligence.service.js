import pool from "../db.js";

/**
 * Reads external execution activity
 * and converts it into intelligence metrics
 */
export async function getExecutionMetrics(workspaceId, month) {
  try {
    const result = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE signal_type = 'INTEGRATION_TASK_COMPLETED'
        ) AS external_completed,

        COUNT(*) FILTER (
          WHERE signal_type = 'INTEGRATION_ACTIVITY_OBSERVED'
          AND (metadata->>'completed') = 'true'
        ) AS external_state_completions

      FROM workspace_execution_signals
      WHERE workspace_id = $1
        AND date_trunc('month', created_at) =
            date_trunc('month', $2::date)
      `,
      [workspaceId, `${month}-01`]
    );

    return {
      externalCompleted:
        Number(result.rows[0].external_completed) || 0,

      externalObservedCompletions:
        Number(result.rows[0].external_state_completions) || 0,
    };

  } catch (err) {
    console.error("Execution metrics error:", err);
    return {
      externalCompleted: 0,
      externalObservedCompletions: 0,
    };
  }
}