// services/attendance.service.js
import { getUserById } from "../repositories/user.repository.js";
import { mirrorAvailabilityToChat } from "./systemChatBot.service.js";

// Separate attendance webhook if you want a different Slack group.
// Falls back to the main SLACK_WEBHOOK_URL if ATTENDANCE_SLACK_WEBHOOK_URL is not set.
const ATTENDANCE_SLACK_WEBHOOK_URL =
  process.env.ATTENDANCE_SLACK_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL ||
  "https://hooks.slack.com/services/XXXX/YYYY/ZZZZ"; // optional fallback

async function sendAttendanceSlack(text, userId) {
  // 1) Always mirror to internal "Availability Updates" chat group
  try {
    await mirrorAvailabilityToChat({ text, userId });
  } catch (err) {
    console.error("Attendance chat mirror failed:", err.message);
  }

  // 2) Optional: also send to Slack
  if (!ATTENDANCE_SLACK_WEBHOOK_URL) {
    console.warn(
      "No ATTENDANCE_SLACK_WEBHOOK_URL configured, skipping Slack attendance."
    );
    return;
  }

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

/**
 * Mark user as signed in (available).
 */
export async function markSignIn(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // ✅ Use real emoji instead of :white_check_mark:
  const text = `✅ *${name}* has *signed in* and is now available.`;
  await sendAttendanceSlack(text, userId);

  // Signing in should clear AWS state, if any
  awsStateByUser.delete(String(userId));
}

/**
 * Mark user as signed off.
 */
export async function markSignOff(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // 👋 instead of :wave:
  const text = `👋 *${name}* has *signed off* and is no longer available.`;
  await sendAttendanceSlack(text, userId);

  // Signing off also clears AWS state
  awsStateByUser.delete(String(userId));
}

/**
 * Mark user as AWS (away from system) for a certain number of minutes.
 */
export async function markAws(userId, minutes) {
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
  await sendAttendanceSlack(text, userId);
}

/**
 * Mark user as on lunch.
 * No time tracking; just a one-shot event.
 */
export async function markLunch(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // Starting lunch also clears any AWS state if it existed.
  awsStateByUser.delete(String(userId));

  // 🍽️ instead of :fork_and_knife:
  const text = `🍽️ *${name}* has started a *lunch break* and is temporarily unavailable.`;
  await sendAttendanceSlack(text, userId);
}

/**
 * Mark the user as available again after AWS or lunch.
 * If AWS state is known, include how early/late they are.
 * If not, send a generic "available again" message.
 */
export async function markAvailableAfterAws(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  const state = awsStateByUser.get(key);
  awsStateByUser.delete(key);

  if (!state) {
    // No AWS record → generic message (also used when returning from lunch)
    // ▶️ instead of :arrow_forward:
    const text = `▶️ *${name}* is *available* again.`;
    await sendAttendanceSlack(text, userId);
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
  await sendAttendanceSlack(text, userId);
}
