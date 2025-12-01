// services/attendance.service.js
import { getUserById } from "../repositories/user.repository.js";

// Separate attendance webhook if you want a different Slack group.
// Falls back to the main SLACK_WEBHOOK_URL if ATTENDANCE_SLACK_WEBHOOK_URL is not set.
const ATTENDANCE_SLACK_WEBHOOK_URL =
  process.env.ATTENDANCE_SLACK_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL ||
  "https://hooks.slack.com/services/XXXX/YYYY/ZZZZ"; // optional fallback

async function sendAttendanceSlack(text) {
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

export async function markSignIn(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const text = `:white_check_mark: *${name}* has *signed in* and is now available.`;
  await sendAttendanceSlack(text);

  // Signing in should clear AWS state, if any
  awsStateByUser.delete(String(userId));
}

export async function markSignOff(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const text = `:wave: *${name}* has *signed off* and is no longer available.`;
  await sendAttendanceSlack(text);

  // Signing off also clears AWS state
  awsStateByUser.delete(String(userId));
}

export async function markAws(userId, minutes) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";
  const mins = Number(minutes);

  const now = new Date();
  const until = new Date(now.getTime() + mins * 60 * 1000);

  awsStateByUser.set(String(userId), {
    startedAt: now,
    plannedMinutes: mins,
  });

  const untilTime = until.toTimeString().slice(0, 5); // HH:MM
  const text = `:pause_button: *${name}* is *AWS* (away from system) for approximately *${mins} minute(s)* (until around *${untilTime}*).`;
  await sendAttendanceSlack(text);
}

// NEW: Lunch break (no time tracking)
export async function markLunch(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  // Starting lunch also clears any AWS state if it existed.
  awsStateByUser.delete(String(userId));

  const text = `:fork_and_knife: *${name}* has started a *lunch break* and is temporarily unavailable.`;
  await sendAttendanceSlack(text);
}

export async function markAvailableAfterAws(userId) {
  const user = await getUserById(userId);
  const name = user?.username || "Unknown user";

  const key = String(userId);
  const state = awsStateByUser.get(key);
  awsStateByUser.delete(key);

  if (!state) {
    // No AWS record → generic message (also used when returning from lunch)
    const text = `:arrow_forward: *${name}* is *available* again.`;
    await sendAttendanceSlack(text);
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

  const text = `:arrow_forward: *${name}* is *available* again${extraNote}.`;
  await sendAttendanceSlack(text);
}
