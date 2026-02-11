import pool from "../../../db.js";

export async function saveNudgeThrottle({
  workspaceId,
  nudgeType,
  decision,
  evaluatedMonth,
  metrics,
}) {
  await pool.query(
    `
    INSERT INTO workspace_coaching_throttle (
      workspace_id,
      nudge_type,
      decision,
      evaluated_month,
      metrics
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (workspace_id, nudge_type)
    DO UPDATE SET
      decision = EXCLUDED.decision,
      evaluated_month = EXCLUDED.evaluated_month,
      metrics = EXCLUDED.metrics,
      created_at = now()
    `,
    [
      workspaceId,
      nudgeType,
      decision,
      evaluatedMonth,
      metrics,
    ]
  );
}
