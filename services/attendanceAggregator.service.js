import pool from "../db.js";

const PRESENCE_EVENTS = new Set([
  "SIGN_IN",
  "AVAILABLE",
  "AWS_START",
  "AWS_END",
  "LUNCH_START",
  "LUNCH_END",
  "SIGN_OFF",
]);

const SCREEN_EVENTS = new Set(["SCREEN_ON", "SCREEN_OFF"]);

function minutesBetween(start, end) {
  const diff = Math.floor((end.getTime() - start.getTime()) / 60000);
  return diff > 0 ? diff : 0;
}

function applyEvent(state, eventType) {
  switch (String(eventType || "").toUpperCase()) {
    case "SIGN_IN":
    case "AVAILABLE":
    case "AWS_END":
    case "LUNCH_END":
      state.signedIn = true;
      state.availability = "available";
      return;
    case "AWS_START":
      state.signedIn = true;
      state.availability = "aws";
      return;
    case "LUNCH_START":
      state.signedIn = true;
      state.availability = "lunch";
      return;
    case "SIGN_OFF":
      state.signedIn = false;
      state.availability = null;
      return;
    case "SCREEN_ON":
      state.screenOn = true;
      return;
    case "SCREEN_OFF":
      state.screenOn = false;
      return;
    default:
      return;
  }
}

function addDurationBuckets(buckets, state, from, to) {
  const mins = minutesBetween(from, to);
  if (mins <= 0) return;

  if (state.signedIn) {
    buckets.signed_in_minutes += mins;

    if (state.availability === "available") buckets.available_minutes += mins;
    else if (state.availability === "aws") buckets.aws_minutes += mins;
    else if (state.availability === "lunch") buckets.lunch_minutes += mins;

    if (state.screenOn) buckets.screen_on_minutes += mins;
    else buckets.screen_off_minutes += mins;
  }
}

function buildScopeClause(column, value, values) {
  if (!value) return "";
  values.push(value);
  return ` AND ${column} = $${values.length}`;
}

/**
 * Aggregate attendance for a given date.
 * Default: yesterday (safe for cron).
 */
export async function aggregateDailyAttendance(targetDate = null, scope = {}) {
  const date =
    targetDate ||
    new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const participantParams = [dayStart, dayEnd];
    const participantWorkspaceClause = buildScopeClause("workspace_id", scope.workspaceId, participantParams);
    const participantUserClause = buildScopeClause("user_id", scope.userId, participantParams);

    const { rows: participants } = await client.query(
      `
      SELECT DISTINCT workspace_id, user_id
      FROM (
        SELECT workspace_id, user_id
        FROM attendance_sessions
        WHERE sign_in_at < $2
          AND COALESCE(sign_off_at, $2) > $1
          ${participantWorkspaceClause}
          ${participantUserClause}

        UNION

        SELECT workspace_id, user_id
        FROM attendance_events
        WHERE started_at >= $1
          AND started_at < $2
          ${participantWorkspaceClause}
          ${participantUserClause}
      ) p
      `,
      participantParams
    );

    for (const p of participants) {
      const workspaceId = p.workspace_id;
      const userId = p.user_id;

      const state = {
        signedIn: false,
        availability: null,
        screenOn: false,
      };

        const { rows: priorStates } = await client.query(
          `
          SELECT DISTINCT ON (category) category, event_type
          FROM (
            SELECT
              CASE
                WHEN event_type IN ('SCREEN_ON', 'SCREEN_OFF') THEN 'screen'
                ELSE 'presence'
              END AS category,
              event_type,
              started_at
            FROM attendance_events
            WHERE workspace_id = $1
              AND user_id = $2
              AND started_at < $3
              AND (
                event_type = ANY($4::text[])
                OR event_type = ANY($5::text[])
              )
          ) s
          ORDER BY category, started_at DESC
          `,
          [workspaceId, userId, dayStart, Array.from(PRESENCE_EVENTS), Array.from(SCREEN_EVENTS)]
        );

      for (const ps of priorStates) {
        applyEvent(state, ps.event_type);
      }

        const { rows: dayEvents } = await client.query(
          `
          SELECT event_type, started_at
          FROM attendance_events
          WHERE workspace_id = $1
            AND user_id = $2
            AND started_at >= $3
            AND started_at < $4
          ORDER BY started_at ASC
          `,
          [workspaceId, userId, dayStart, dayEnd]
        );

      const buckets = {
        signed_in_minutes: 0,
        available_minutes: 0,
        aws_minutes: 0,
        lunch_minutes: 0,
        screen_on_minutes: 0,
        screen_off_minutes: 0,
      };

      let cursor = new Date(dayStart);
      for (const ev of dayEvents) {
        const occurredAt = new Date(ev.started_at);
        addDurationBuckets(buckets, state, cursor, occurredAt);
        applyEvent(state, ev.event_type);
        cursor = occurredAt;
      }
      addDurationBuckets(buckets, state, cursor, dayEnd);

      await client.query(
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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
        ON CONFLICT (workspace_id, user_id, date)
        DO UPDATE SET
          signed_in_minutes = EXCLUDED.signed_in_minutes,
          available_minutes = EXCLUDED.available_minutes,
          aws_minutes = EXCLUDED.aws_minutes,
          lunch_minutes = EXCLUDED.lunch_minutes,
          screen_on_minutes = EXCLUDED.screen_on_minutes,
          screen_off_minutes = EXCLUDED.screen_off_minutes,
          recalculated_at = NOW(),
          updated_at = NOW()
        `,
        [
          workspaceId,
          userId,
          date,
          buckets.signed_in_minutes,
          buckets.available_minutes,
          buckets.aws_minutes,
          buckets.lunch_minutes,
          buckets.screen_on_minutes,
          buckets.screen_off_minutes,
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`[attendance] Aggregated daily attendance for ${date}`);
    return {
      ok: true,
      date,
      participantCount: participants.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[attendance] Aggregation failed:", err);
    return {
      ok: false,
      date,
      error: err.message,
    };
  } finally {
    client.release();
  }
}
