// services/attendanceRecalculate.service.js
import pool from "../db.js";

/**
 * Recalculate DAILY attendance from raw attendance_events
 *
 * @param {Object} options
 * @param {string} options.workspaceId  (required)
 * @param {string|null} options.userId  (optional)
 * @param {string|null} options.from    YYYY-MM-DD (optional)
 * @param {string|null} options.to      YYYY-MM-DD (optional)
 */
export async function recalculateDailyAttendance({
  workspaceId,
  userId = null,
  from = null,
  to = null,
}) {
  if (!workspaceId) {
    throw new Error("workspaceId is required for recalculation");
  }

  // -------------------------------
  // 1️⃣ Build filters
  // -------------------------------
  const conditions = [`workspace_id = $1`];
  const values = [workspaceId];
  let idx = 2;

  if (userId) {
    conditions.push(`user_id = $${idx++}`);
    values.push(userId);
  }

  if (from) {
    conditions.push(`DATE(created_at) >= $${idx++}`);
    values.push(from);
  }

  if (to) {
    conditions.push(`DATE(created_at) <= $${idx++}`);
    values.push(to);
  }

  // -------------------------------
  // 2️⃣ Load raw events
  // -------------------------------
  const { rows: events } = await pool.query(
    `
    SELECT
      user_id,
      workspace_id,
      event_type,
      created_at AS occurred_at,
      DATE(created_at) AS event_date
    FROM attendance_events
    WHERE ${conditions.join(" AND ")}
    ORDER BY user_id, created_at ASC
    `,
    values
  );

  if (events.length === 0) {
    return { daysProcessed: 0, usersProcessed: 0 };
  }

  // -------------------------------
  // 3️⃣ Group events by user + date
  // -------------------------------
  const grouped = new Map();

  for (const e of events) {
    const key = `${e.user_id}_${e.event_date}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        userId: e.user_id,
        workspaceId: e.workspace_id,
        date: e.event_date,
        events: [],
      });
    }
    grouped.get(key).events.push(e);
  }

  // -------------------------------
  // 4️⃣ Process each day
  // -------------------------------
  let daysProcessed = 0;
  const users = new Set();

  for (const day of grouped.values()) {
    const buckets = {
      SIGNED_IN: 0,
      AVAILABLE: 0,
      AWS: 0,
      LUNCH: 0,
      SCREEN_ON: 0,
      SCREEN_OFF: 0,
    };

    let lastState = null;
    let lastTime = null;

    for (const ev of day.events) {
      const now = new Date(ev.occurred_at);

      if (lastState && lastTime) {
        const diffMinutes = Math.floor(
          (now.getTime() - lastTime.getTime()) / 60000
        );

        if (diffMinutes > 0) {
          switch (lastState) {
            case "SIGN_IN":
              buckets.SIGNED_IN += diffMinutes;
              break;
            case "AVAILABLE":
              buckets.AVAILABLE += diffMinutes;
              break;
            case "AWS":
              buckets.AWS += diffMinutes;
              break;
            case "LUNCH":
              buckets.LUNCH += diffMinutes;
              break;
            case "SCREEN_ON":
              buckets.SCREEN_ON += diffMinutes;
              break;
            case "SCREEN_OFF":
              buckets.SCREEN_OFF += diffMinutes;
              break;
          }
        }
      }

      lastState = ev.event_type;
      lastTime = now;
    }

    // -------------------------------
    // 5️⃣ Upsert daily aggregation
    // -------------------------------
    await pool.query(
      `
      INSERT INTO attendance_daily (
        workspace_id,
        user_id,
        date,
        signed_in_minutes,
        available_minutes,
        aws_minutes,
        lunch_minutes,
        screen_on_minutes,
        screen_off_minutes,
        recalculated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      ON CONFLICT (workspace_id, user_id, date)
      DO UPDATE SET
        signed_in_minutes = EXCLUDED.signed_in_minutes,
        available_minutes = EXCLUDED.available_minutes,
        aws_minutes = EXCLUDED.aws_minutes,
        lunch_minutes = EXCLUDED.lunch_minutes,
        screen_on_minutes = EXCLUDED.screen_on_minutes,
        screen_off_minutes = EXCLUDED.screen_off_minutes,
        recalculated_at = now()
      `,
      [
        day.workspaceId,
        day.userId,
        day.date,
        buckets.SIGNED_IN,
        buckets.AVAILABLE,
        buckets.AWS,
        buckets.LUNCH,
        buckets.SCREEN_ON,
        buckets.SCREEN_OFF,
      ]
    );

    daysProcessed++;
    users.add(day.userId);
  }

  return {
    daysProcessed,
    usersProcessed: users.size,
  };
}
