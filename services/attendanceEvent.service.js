import pool from "../db.js";

export async function startAttendanceEvent({
  sessionId,
  userId,
  workspaceId,
  eventType,
}) {
  // Close any open event
  await pool.query(
    `
    UPDATE attendance_events
    SET ended_at = now()
    WHERE session_id = $1
      AND ended_at IS NULL;
    `,
    [sessionId]
  );

  const res = await pool.query(
    `
    INSERT INTO attendance_events (
      session_id,
      user_id,
      workspace_id,
      event_type,
      started_at
    )
    VALUES ($1, $2, $3, $4, now())
    RETURNING *;
    `,
    [sessionId, userId, workspaceId, eventType]
  );

  return res.rows[0];
}
