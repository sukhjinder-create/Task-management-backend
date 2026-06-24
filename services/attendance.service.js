import pool from "../db.js";
import { randomUUID } from "crypto";
import { getUserById } from "../repositories/user.repository.js";
import { ensureSystemUser } from "./ai.system.service.js";
import { mirrorAvailabilityToChat } from "./systemChatBot.service.js";
import { createChatMessage } from "./chat.service.js";

const WORKSPACE_GLOBAL = "GLOBAL";

/* ------------------------------------------------------------
   EVENT TYPES — MUST MATCH DB CHECK CONSTRAINT
------------------------------------------------------------ */
const EVENT = {
  SIGN_IN: "SIGN_IN",
  SIGN_OFF: "SIGN_OFF",
  AWS_START: "AWS_START",
  AWS_END: "AWS_END",
  LUNCH_START: "LUNCH_START",
  LUNCH_END: "LUNCH_END",
  AVAILABLE: "AVAILABLE",
  SCREEN_ON: "SCREEN_ON",
  SCREEN_OFF: "SCREEN_OFF",
};

// Separate attendance webhook if you want a different Slack group.
const ATTENDANCE_SLACK_WEBHOOK_URL =
  process.env.ATTENDANCE_SLACK_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL ||
  null;

/* ------------------------------------------------------------
   🧠 SESSION TRACKING (IN-MEMORY, SAFE)
------------------------------------------------------------ */
// userId -> sessionId
const attendanceSessionByUser = new Map();

/* ------------------------------------------------------------
   🧠 AWS STATE TRACKING (UNCHANGED)
------------------------------------------------------------ */
// userId -> { startedAt, plannedMinutes }
const awsStateByUser = new Map();

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function minutesSince(value) {
  if (!value) return 0;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 60000);
}

function mapLiveStatus(eventType) {
  switch (eventType) {
    case EVENT.AWS_START:
      return "aws";
    case EVENT.LUNCH_START:
      return "lunch";
    default:
      return "available";
  }
}

function statusLabel(status) {
  switch (status) {
    case "aws":
      return "AWS";
    case "lunch":
      return "Lunch";
    case "on_leave":
      return "On leave";
    case "offline":
      return "Not signed in";
    default:
      return "Present";
  }
}

function bucket(users, status) {
  return users.filter((user) => user.status === status);
}

/* ------------------------------------------------------------
   🧠 ATTENDANCE SESSION DB HELPERS (ADD-ONLY)
------------------------------------------------------------ */
async function createSession({ sessionId, userId, workspaceId }) {
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) return;

  await pool.query(
    `
    INSERT INTO attendance_sessions (
      id,
      user_id,
      workspace_id,
      sign_in_at
    )
    VALUES ($1, $2, $3, now())
    `,
    [sessionId, userId, workspaceId]
  );
}

async function closeSession(sessionId) {
  if (!sessionId) return;

  await pool.query(
    `
    UPDATE attendance_sessions
    SET sign_off_at = now()
    WHERE id = $1
    `,
    [sessionId]
  );
}

/* ------------------------------------------------------------
   🔍 OPEN SESSION LOOKUP (ADD-ONLY)
------------------------------------------------------------ */
async function getOpenSessionId(userId, workspaceId) {
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) return null;

  const { rows } = await pool.query(
    `
    SELECT id
    FROM attendance_sessions
    WHERE user_id = $1
      AND workspace_id = $2
      AND sign_off_at IS NULL
    LIMIT 1
    `,
    [userId, workspaceId]
  );

  return rows[0]?.id || null;
}

async function ensureOpenSessionForUser(userId, workspaceId) {
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) return null;

  const key = String(userId);
  let sessionId = attendanceSessionByUser.get(key);
  if (sessionId) return sessionId;

  sessionId = await getOpenSessionId(userId, workspaceId);
  if (sessionId) {
    attendanceSessionByUser.set(key, sessionId);
    return sessionId;
  }

  // Fallback: create a new session if runtime state is out-of-sync.
  const newSessionId = randomUUID();
  await createSession({ sessionId: newSessionId, userId, workspaceId });
  await recordAttendanceEvent({
    userId,
    workspaceId,
    sessionId: newSessionId,
    eventType: EVENT.SIGN_IN,
    // Ensure subsequent state change events (e.g., lunch) sort later.
    startedAt: new Date(Date.now() - 1000),
  });
  attendanceSessionByUser.set(key, newSessionId);
  return newSessionId;
}

/* ------------------------------------------------------------
   🔥 HARD SESSION RESET (ADD-ONLY)
------------------------------------------------------------ */
async function forceCloseOpenSessions(userId, workspaceId) {
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) return;

  await pool.query(
    `
    UPDATE attendance_sessions
    SET sign_off_at = now()
    WHERE user_id = $1
      AND workspace_id = $2
      AND sign_off_at IS NULL
    `,
    [userId, workspaceId]
  );
}

/* ------------------------------------------------------------
   🧠 SAFE DB INSERT (UNCHANGED)
------------------------------------------------------------ */
async function recordAttendanceEvent({
  userId,
  workspaceId,
  sessionId,
  eventType,
  startedAt = new Date(),
  endedAt = null,
}) {
  if (!workspaceId || workspaceId === WORKSPACE_GLOBAL) {
    return;
  }

  if (!sessionId) {
    console.warn(
      "[attendance] Missing sessionId, skipping DB insert",
      { userId, eventType }
    );
    return;
  }

  await pool.query(
    `
    INSERT INTO attendance_events (
      session_id,
      user_id,
      workspace_id,
      event_type,
      started_at,
      ended_at
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [sessionId, userId, workspaceId, eventType, startedAt, endedAt]
  );
}

/* ------------------------------------------------------------
   CHAT + SLACK (UNCHANGED)
------------------------------------------------------------ */
async function sendAttendanceSlack(text, userId, workspaceId) {
  if (workspaceId && workspaceId !== WORKSPACE_GLOBAL) {
    try {
   const systemUser = await ensureSystemUser(workspaceId);

await createChatMessage({
  channelKey: "availability-updates",
  userId: systemUser.id,   // 🔥 THIS IS THE KEY
  textHtml: text,
  workspaceId,
});

    } catch (err) {
      console.error("Attendance chat mirror failed:", err.message);
    }
  }

  if (!ATTENDANCE_SLACK_WEBHOOK_URL) return;

  try {
    await fetch(ATTENDANCE_SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Slack attendance error:", err.message);
  }
}

/* ------------------------------------------------------------
   ATTENDANCE ACTIONS
------------------------------------------------------------ */

/**
 * SIGN IN
 */
export async function markSignIn(userId, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // 🛑 HARD GUARD — prevent duplicate chat / sign-in spam
  const existingSessionId = await getOpenSessionId(userId, workspaceId);
  if (existingSessionId) {
    attendanceSessionByUser.set(String(userId), existingSessionId);
    return false;
  }

  // 🔥 HARD RESET — close any orphaned session (safety net)
  await forceCloseOpenSessions(userId, workspaceId);

  const sessionId = randomUUID();
  attendanceSessionByUser.set(String(userId), sessionId);

  await createSession({ sessionId, userId, workspaceId });

  await recordAttendanceEvent({
    userId,
    workspaceId,
    sessionId,
    eventType: EVENT.SIGN_IN,
  });

  awsStateByUser.delete(String(userId));

  await sendAttendanceSlack(
    `✅ *${name}* has *signed in* and is now available.`,
    userId,
    workspaceId
  );

  return true;
}

/**
 * SIGN OFF
 */
export async function markSignOff(userId, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  let sessionId = attendanceSessionByUser.get(key);

  if (!sessionId) {
    sessionId = await getOpenSessionId(userId, workspaceId);
  }

  if (!sessionId) {
    console.warn("[attendance] No open session found for sign-off", {
      userId,
      workspaceId,
    });
    return false;
  }

  await recordAttendanceEvent({
    userId,
    workspaceId,
    sessionId,
    eventType: EVENT.SIGN_OFF,
    endedAt: new Date(),
  });

  await closeSession(sessionId);

  awsStateByUser.delete(key);
  attendanceSessionByUser.delete(key);

  await sendAttendanceSlack(
    `👋 *${name}* has *signed off* and is no longer available.`,
    userId,
    workspaceId
  );

  return true;
}

/**
 * AWS START
 */
export async function markAws(userId, minutes, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";
  const mins = Number(minutes) || 0;

  const key = String(userId);
  const sessionId = await ensureOpenSessionForUser(userId, workspaceId);
  if (!sessionId) {
    console.warn("[attendance] No open session found for AWS", {
      userId,
      workspaceId,
    });
    return false;
  }

  const now = new Date();

  awsStateByUser.set(key, {
    startedAt: now,
    plannedMinutes: mins,
  });

  await recordAttendanceEvent({
    userId,
    workspaceId,
    sessionId,
    eventType: EVENT.AWS_START,
    startedAt: now,
  });

  await sendAttendanceSlack(
    `⏸️ *${name}* is *AWS* for approximately *${mins} minute(s)*.`,
    userId,
    workspaceId
  );

  return true;
}

/**
 * LUNCH START
 */
export async function markLunch(userId, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  const sessionId = await ensureOpenSessionForUser(userId, workspaceId);
  if (!sessionId) {
    console.warn("[attendance] No open session found for lunch", {
      userId,
      workspaceId,
    });
    return false;
  }

  awsStateByUser.delete(key);

  await recordAttendanceEvent({
    userId,
    workspaceId,
    sessionId,
    eventType: EVENT.LUNCH_START,
  });

  await sendAttendanceSlack(
    `🍽️ *${name}* has started a *lunch break*.`,
    userId,
    workspaceId
  );

  return true;
}

/**
 * AVAILABLE AGAIN
 */
export async function markAvailableAfterAws(userId, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  let sessionId = attendanceSessionByUser.get(key);
  if (!sessionId) {
    sessionId = await getOpenSessionId(userId, workspaceId);
    if (sessionId) {
      attendanceSessionByUser.set(key, sessionId);
    }
  }
  if (!sessionId) {
    console.warn("[attendance] No open session found for available", {
      userId,
      workspaceId,
    });
    return false;
  }

  const state = awsStateByUser.get(key);
  awsStateByUser.delete(key);

  await recordAttendanceEvent({
    userId,
    workspaceId,
    sessionId,
    eventType: EVENT.AVAILABLE,
  });

  if (!state) {
    await sendAttendanceSlack(
      `▶️ *${name}* is *available* again.`,
      userId,
      workspaceId
    );
    return true;
  }

  const elapsed = Math.max(
    1,
    Math.round((Date.now() - state.startedAt) / 60000)
  );

  const planned = state.plannedMinutes;

  let note = "";
  if (elapsed < planned) note = ` (returned earlier than planned)`;
  else if (elapsed > planned) note = ` (returned later than planned)`;
  else note = ` (returned as planned)`;

  await sendAttendanceSlack(
    `▶️ *${name}* is *available* again${note}.`,
    userId,
    workspaceId
  );

  return true;
}

/* ------------------------------------------------------------
   LEGACY WRAPPERS (UNCHANGED)
------------------------------------------------------------ */
export async function markSignInLegacy(userId) {
  return markSignIn(userId, WORKSPACE_GLOBAL);
}

export async function markSignOffLegacy(userId) {
  return markSignOff(userId, WORKSPACE_GLOBAL);
}

export async function markAwsLegacy(userId, minutes) {
  return markAws(userId, minutes, WORKSPACE_GLOBAL);
}

export async function markLunchLegacy(userId) {
  return markLunch(userId, WORKSPACE_GLOBAL);
}

export async function markAvailableAfterAwsLegacy(userId) {
  return markAvailableAfterAws(userId, WORKSPACE_GLOBAL);
}

export async function getLiveAttendanceDashboard({ workspaceId, userId, role }) {
  const normalizedRole = String(role || "").toLowerCase();
  const { rows: dateRows } = await pool.query("SELECT CURRENT_DATE::text AS today");
  const today = dateRows[0]?.today || new Date().toISOString().slice(0, 10);

  const baseParams = [workspaceId];
  let userScopeSql = "";
  if (normalizedRole === "manager") {
    baseParams.push(userId);
    userScopeSql = `
      AND (
        u.id = $2
        OR u.id IN (
          SELECT DISTINCT t.assigned_to
          FROM tasks t
          JOIN users manager_user ON manager_user.id = $2
          WHERE t.workspace_id = $1
            AND t.assigned_to IS NOT NULL
            AND t.project_id = ANY(COALESCE(manager_user.projects, ARRAY[]::uuid[]))
        )
      )
    `;
  } else if (!["admin", "owner"].includes(normalizedRole)) {
    baseParams.push(userId);
    userScopeSql = "AND u.id = $2";
  }

  const { rows: visibleUsers } = await pool.query(
    `
    SELECT
      u.id::text AS user_id,
      u.username,
      u.email,
      u.role,
      u.avatar_url
    FROM users u
    JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
    WHERE COALESCE(wu.billing_status, 'active') <> 'pending'
      AND COALESCE(u.role, '') NOT IN ('system', 'superadmin')
      AND LOWER(COALESCE(u.username, '')) <> 'autopilot'
      ${userScopeSql}
    ORDER BY u.username ASC
    `,
    baseParams
  );

  const userIds = visibleUsers.map((user) => user.user_id);
  if (!userIds.length) {
    return {
      source: "attendance_live",
      generatedAt: new Date().toISOString(),
      date: today,
      scope: { role: normalizedRole || "user", userCount: 0 },
      totals: { present: 0, available: 0, aws: 0, lunch: 0, onLeave: 0, notSignedIn: 0 },
      buckets: { available: [], aws: [], lunch: [], onLeave: [], notSignedIn: [] },
      users: [],
    };
  }

  const [sessionResult, leaveResult] = await Promise.all([
    pool.query(
      `
      SELECT
        s.user_id::text AS user_id,
        s.sign_in_at,
        COALESCE(ev.event_type, 'SIGN_IN') AS latest_event_type,
        COALESCE(ev.started_at, s.sign_in_at) AS latest_event_started_at
      FROM attendance_sessions s
      LEFT JOIN LATERAL (
        SELECT e.event_type, e.started_at
        FROM attendance_events e
        WHERE e.session_id = s.id
        ORDER BY e.started_at DESC
        LIMIT 1
      ) ev ON TRUE
      WHERE s.workspace_id = $1
        AND s.sign_off_at IS NULL
        AND s.user_id = ANY($2::uuid[])
      `,
      [workspaceId, userIds]
    ),
    pool.query(
      `
      SELECT
        lr.user_id::text AS user_id,
        lr.start_date,
        lr.end_date,
        lt.name AS leave_type_name,
        lt.color AS leave_type_color
      FROM leave_requests lr
      LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.workspace_id = $1
        AND lr.status = 'approved'
        AND $2::date BETWEEN lr.start_date AND lr.end_date
        AND lr.user_id = ANY($3::uuid[])
      `,
      [workspaceId, today, userIds]
    ),
  ]);

  const liveByUser = new Map(sessionResult.rows.map((row) => [String(row.user_id), row]));
  const leaveByUser = new Map(leaveResult.rows.map((row) => [String(row.user_id), row]));

  const users = visibleUsers.map((user) => {
    const live = liveByUser.get(String(user.user_id));
    const leave = leaveByUser.get(String(user.user_id));
    const status = live ? mapLiveStatus(live.latest_event_type) : leave ? "on_leave" : "offline";
    const statusSince = live?.latest_event_started_at || leave?.start_date || null;
    return {
      userId: user.user_id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatar_url || null,
      status,
      label: statusLabel(status),
      signedInAt: toIso(live?.sign_in_at),
      statusSince: toIso(statusSince),
      statusMinutes: live ? minutesSince(statusSince) : null,
      leave: leave
        ? {
            type: leave.leave_type_name || "Leave",
            color: leave.leave_type_color || null,
            startDate: leave.start_date,
            endDate: leave.end_date,
          }
        : null,
    };
  });

  const available = bucket(users, "available");
  const aws = bucket(users, "aws");
  const lunch = bucket(users, "lunch");
  const onLeave = bucket(users, "on_leave");
  const notSignedIn = bucket(users, "offline");

  return {
    source: "attendance_live",
    generatedAt: new Date().toISOString(),
    date: today,
    scope: { role: normalizedRole || "user", userCount: users.length },
    totals: {
      present: available.length + aws.length + lunch.length,
      available: available.length,
      aws: aws.length,
      lunch: lunch.length,
      onLeave: onLeave.length,
      notSignedIn: notSignedIn.length,
    },
    buckets: {
      available,
      aws,
      lunch,
      onLeave,
      notSignedIn,
    },
    users,
  };
}

/* ------------------------------------------------------------
   DEFAULT EXPORT (UNCHANGED)
------------------------------------------------------------ */
export default {
  markSignIn,
  markSignOff,
  markAws,
  markLunch,
  markAvailableAfterAws,
  markSignInLegacy,
  markSignOffLegacy,
  markAwsLegacy,
  markLunchLegacy,
  markAvailableAfterAwsLegacy,
  getLiveAttendanceDashboard,
};
