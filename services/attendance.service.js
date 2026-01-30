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
    return; // 🚫 do NOTHING else
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
    return;
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
}

/**
 * AWS START
 */
export async function markAws(userId, minutes, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";
  const mins = Number(minutes) || 0;

  const key = String(userId);
  const sessionId = attendanceSessionByUser.get(key);
  if (!sessionId) return;

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
}

/**
 * LUNCH START
 */
export async function markLunch(userId, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  const sessionId = attendanceSessionByUser.get(key);
  if (!sessionId) return;

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
}

/**
 * AVAILABLE AGAIN
 */
export async function markAvailableAfterAws(userId, workspaceId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  const sessionId = attendanceSessionByUser.get(key);
  if (!sessionId) return;

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
    return;
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
};
