import pool from "../db.js";

export async function recordScreenActivity({
  userId,
  workspaceId,
  screenState,
}) {
  // Close previous
  await pool.query(
    `
    UPDATE screen_activity_events
    SET ended_at = now()
    WHERE user_id = $1
      AND workspace_id = $2
      AND ended_at IS NULL;
    `,
    [userId, workspaceId]
  );

  await pool.query(
    `
    INSERT INTO screen_activity_events (
      user_id,
      workspace_id,
      screen_state,
      started_at
    )
    VALUES ($1, $2, $3, now());
    `,
    [userId, workspaceId, screenState]
  );
}
