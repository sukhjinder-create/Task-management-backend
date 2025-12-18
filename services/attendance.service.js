// src/services/attendance.service.js
import { getUserById } from "../repositories/user.repository.js";
import { mirrorAvailabilityToChat } from "./systemChatBot.service.js";

const WORKSPACE_GLOBAL = "GLOBAL";

// Separate attendance webhook if you want a different Slack group.
// Falls back to the main SLACK_WEBHOOK_URL if ATTENDANCE_SLACK_WEBHOOK_URL is not set.
const ATTENDANCE_SLACK_WEBHOOK_URL =
  process.env.ATTENDANCE_SLACK_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL ||
  null;

/**
 * Workspace-aware sendAttendanceSlack.
 * Keep workspaceId optional and default to WORKSPACE_GLOBAL.
 */

async function sendAttendanceSlack(
  text,
  userId,
  workspaceId
) {
  // 🔐 MUST have workspace for chat
  if (workspaceId) {
    try {
      await mirrorAvailabilityToChat({
  text,
  userId,
  workspaceId:
    workspaceId && workspaceId !== "GLOBAL"
      ? workspaceId
      : null,
});
    } catch (err) {
      console.error("Attendance chat mirror failed:", err.message);
    }
  }

  // 📣 Slack is independent
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


// In-memory AWS state per user: { startedAt: Date, plannedMinutes: number }
const awsStateByUser = new Map();

/* ------------------------------------------------------------
   Workspace-aware attendance functions (original canonical)
   These accept an optional workspaceId (default WORKSPACE_GLOBAL).
------------------------------------------------------------ */

/**
 * Mark user as signed in (available).
 * Accepts optional workspaceId so route can pass req.workspaceId.
 */
export async function markSignIn(userId, workspaceId = WORKSPACE_GLOBAL) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // ✅ Use real emoji instead of :white_check_mark:
  const text = `✅ *${name}* has *signed in* and is now available.`;
  await sendAttendanceSlack(text, userId, workspaceId);

  // Signing in should clear AWS state, if any
  awsStateByUser.delete(String(userId));
}

/**
 * Mark user as signed off.
 */
export async function markSignOff(userId, workspaceId = WORKSPACE_GLOBAL) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // 👋 instead of :wave:
  const text = `👋 *${name}* has *signed off* and is no longer available.`;
  await sendAttendanceSlack(text, userId, workspaceId);

  // Signing off also clears AWS state
  awsStateByUser.delete(String(userId));
}

/**
 * Mark user as AWS (away from system) for a certain number of minutes.
 */
export async function markAws(userId, minutes, workspaceId = WORKSPACE_GLOBAL) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";
  const mins = Number(minutes) || 0;

  const now = new Date();
  const until = new Date(now.getTime() + mins * 60 * 1000);

  awsStateByUser.set(String(userId), {
    startedAt: now,
    plannedMinutes: mins,
  });

  const untilTime = until.toTimeString().slice(0, 5); // HH:MM

  // ⏸️ instead of :pause_button:
  const text = `⏸️ *${name}* is *AWS* (away from system) for approximately *${mins} minute(s)* (until around *${untilTime}*).`;
  await sendAttendanceSlack(text, userId, workspaceId);
}

/**
 * Mark user as on lunch.
 * No time tracking; just a one-shot event.
 */
export async function markLunch(userId, workspaceId = WORKSPACE_GLOBAL) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // Starting lunch also clears any AWS state if it existed.
  awsStateByUser.delete(String(userId));

  // 🍽️ instead of :fork_and_knife:
  const text = `🍽️ *${name}* has started a *lunch break* and is temporarily unavailable.`;
  await sendAttendanceSlack(text, userId, workspaceId);
}

/**
 * Mark the user as available again after AWS or lunch.
 * If AWS state is known, include how early/late they are.
 * If not, send a generic "available again" message.
 */
export async function markAvailableAfterAws(userId, workspaceId = WORKSPACE_GLOBAL) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  const state = awsStateByUser.get(key);
  awsStateByUser.delete(key);

  if (!state) {
    // No AWS record → generic message (also used when returning from lunch)
    // ▶️ instead of :arrow_forward:
    const text = `▶️ *${name}* is *available* again.`;
    await sendAttendanceSlack(text, userId, workspaceId);
    return;
  }

  const now = new Date();
  const diffMs = now.getTime() - state.startedAt.getTime();
  let elapsed = Math.round(diffMs / 60000);
  if (elapsed <= 0) elapsed = 1;

  const planned = state.plannedMinutes;

  let extraNote = "";
  if (elapsed < planned) {
    extraNote = ` (back *earlier* than planned: AWS was ${planned} min, returned after ~${elapsed} min)`;
  } else if (elapsed > planned) {
    extraNote = ` (back *later* than planned: AWS was ${planned} min, returned after ~${elapsed} min)`;
  } else {
    extraNote = ` (back as planned after ~${elapsed} min)`;
  }

  const text = `▶️ *${name}* is *available* again${extraNote}.`;
  await sendAttendanceSlack(text, userId, workspaceId);
}

/* ------------------------------------------------------------
   Legacy (non-workspace) wrappers
   These preserve the exact no-workspace signatures from the second file.
   They simply call the workspace-aware functions with WORKSPACE_GLOBAL.
   This keeps existing callers (that expect the shorter signature) working
   while also preserving the workspace-capable API.
------------------------------------------------------------ */

/**
 * Legacy wrapper: markSignIn(userId)
 * Calls markSignIn(userId, WORKSPACE_GLOBAL)
 */
export async function markSignInLegacy(userId) {
  return markSignIn(userId, WORKSPACE_GLOBAL);
}

/**
 * Legacy wrapper: markSignOff(userId)
 */
export async function markSignOffLegacy(userId) {
  return markSignOff(userId, WORKSPACE_GLOBAL);
}

/**
 * Legacy wrapper: markAws(userId, minutes)
 */
export async function markAwsLegacy(userId, minutes) {
  return markAws(userId, minutes, WORKSPACE_GLOBAL);
}

/**
 * Legacy wrapper: markLunch(userId)
 */
export async function markLunchLegacy(userId) {
  return markLunch(userId, WORKSPACE_GLOBAL);
}

/**
 * Legacy wrapper: markAvailableAfterAws(userId)
 */
export async function markAvailableAfterAwsLegacy(userId) {
  return markAvailableAfterAws(userId, WORKSPACE_GLOBAL);
}

/* ------------------------------------------------------------
   Default export (includes both workspace-aware + legacy wrappers)
------------------------------------------------------------ */
export default {
  // workspace-aware
  markSignIn,
  markSignOff,
  markAws,
  markLunch,
  markAvailableAfterAws,
  // legacy wrappers (no workspace param)
  markSignInLegacy,
  markSignOffLegacy,
  markAwsLegacy,
  markLunchLegacy,
  markAvailableAfterAwsLegacy,
};
