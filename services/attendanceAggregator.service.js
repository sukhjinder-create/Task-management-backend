import pool from "../db.js";

/**
 * Aggregate attendance for a given date
 * Default: yesterday (safe for cron)
 */
export async function aggregateDailyAttendance(targetDate = null) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // default = yesterday
    const date =
      targetDate ||
      new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

    /**
     * Assumption:
     * attendance_events table has:
     * - user_id
     * - workspace_id
     * - event_type
     * - duration_minutes
     * - created_at
     */

    const aggregationQuery = `
      INSERT INTO daily_attendance (
        workspace_id,
        user_id,
        date,
        total_signed_in_minutes,
        available_minutes,
        aws_minutes,
        lunch_minutes,
        screen_on_minutes,
        screen_off_minutes
      )
      SELECT
        workspace_id,
        user_id,
        DATE(created_at) AS date,

        SUM(CASE WHEN event_type = 'signed_in' THEN duration_minutes ELSE 0 END),
        SUM(CASE WHEN event_type = 'available' THEN duration_minutes ELSE 0 END),
        SUM(CASE WHEN event_type = 'aws' THEN duration_minutes ELSE 0 END),
        SUM(CASE WHEN event_type = 'lunch' THEN duration_minutes ELSE 0 END),
        SUM(CASE WHEN event_type = 'screen_on' THEN duration_minutes ELSE 0 END),
        SUM(CASE WHEN event_type = 'screen_off' THEN duration_minutes ELSE 0 END)

      FROM attendance_events
      WHERE DATE(created_at) = $1
      GROUP BY workspace_id, user_id, DATE(created_at)

      ON CONFLICT (workspace_id, user_id, date)
      DO UPDATE SET
        total_signed_in_minutes = EXCLUDED.total_signed_in_minutes,
        available_minutes = EXCLUDED.available_minutes,
        aws_minutes = EXCLUDED.aws_minutes,
        lunch_minutes = EXCLUDED.lunch_minutes,
        screen_on_minutes = EXCLUDED.screen_on_minutes,
        screen_off_minutes = EXCLUDED.screen_off_minutes,
        updated_at = NOW();
    `;

    await client.query(aggregationQuery, [date]);

    await client.query("COMMIT");
    console.log(`[attendance] Aggregated daily attendance for ${date}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[attendance] Aggregation failed:", err);
  } finally {
    client.release();
  }
}
