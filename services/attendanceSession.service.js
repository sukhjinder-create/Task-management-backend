import pool from "../db.js";

export async function startAttendanceSession(userId, workspaceId) {
  const res = await pool.query(
    `
    INSERT INTO attendance_sessions (user_id, workspace_id, sign_in_at)
    VALUES ($1, $2, now())
    ON CONFLICT (user_id, workspace_id)
    DO UPDATE SET sign_in_at = attendance_sessions.sign_in_at
    RETURNING *;
    `,
    [userId, workspaceId]
  );
  return res.rows[0];
}

export async function endAttendanceSession(userId, workspaceId) {
  const res = await pool.query(
    `
    UPDATE attendance_sessions
    SET sign_off_at = now()
    WHERE user_id = $1
      AND workspace_id = $2
      AND sign_off_at IS NULL
    RETURNING *;
    `,
    [userId, workspaceId]
  );
  return res.rows[0] || null;
}
