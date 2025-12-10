// services/notification.service.js
import {
  createNotification as repoCreateNotification,
  getNotificationsByUser,
  markNotificationRead,
  markAllNotificationsRead,
} from "../repositories/notification.repository.js";
import { getIO } from "../realtime/socket.js";
import nodemailer from "nodemailer";
import { getUserById } from "../repositories/user.repository.js";
import { mirrorProjectNotificationToChat } from "./systemChatBot.service.js";

// ─────────────────────────────
// Config
// ─────────────────────────────

// Frontend base URL for deep-links (set in .env for prod)
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "http://localhost:5173";

// Slack webhook (env preferred)
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || null;

// Email config
const EMAIL_NOTIFICATIONS_ENABLED =
  process.env.EMAIL_NOTIFICATIONS_ENABLED === "true";

let mailTransporter = null;

if (
  EMAIL_NOTIFICATIONS_ENABLED &&
  process.env.SMTP_HOST &&
  process.env.SMTP_PORT &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  process.env.EMAIL_FROM
) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ─────────────────────────────
// Slack helpers
// ─────────────────────────────

async function sendSlackWebhook(text) {
  if (!SLACK_WEBHOOK_URL) return;

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Slack notification error:", err.message);
  }
}

async function buildSlackText({
  user_id,
  type,
  message,
  task_id,
  project_id,
  comment_id,
}) {
  // Target user (receiver of the notification)
  let targetName = "user";
  try {
    const user = await getUserById(user_id);
    if (user?.username) targetName = user.username;
    else if (user?.email) targetName = user.email;
  } catch {
    // ignore
  }

  let body = message || "";

  // Make text a bit more group-friendly
  if (type === "task_assigned") {
    body = body.replace(
      "You have been assigned",
      `${targetName} has been assigned`
    );
  } else if (type === "project_assigned") {
    body = body.replace(
      "You have been assigned",
      `${targetName} has been assigned`
    );
  } else if (type === "comment_mention") {
    body = body.replace(/\byou\b/gi, targetName);
  }

  // Build frontend URL similar to in-app navigation
  let linkUrl = null;

  if (project_id) {
    // task + optional comment deep-link
    if (task_id) {
      const params = new URLSearchParams();
      params.set("task", task_id);
      if (comment_id) params.set("comment", comment_id);
      linkUrl = `${FRONTEND_BASE_URL}/projects/${project_id}?${params.toString()}`;
    } else {
      linkUrl = `${FRONTEND_BASE_URL}/projects/${project_id}`;
    }
  } else if (task_id) {
    // Fallback: My Tasks view
    linkUrl = `${FRONTEND_BASE_URL}/my-tasks`;
  }

  const prefix = "🔔"; // real emoji for all places
  const linkPart = linkUrl ? ` – <${linkUrl}|Open in TaskManager>` : "";

  return `${prefix} ${body}${linkPart}`;
}

// ─────────────────────────────
// Email helper
// ─────────────────────────────

async function sendEmailNotification(
  userId,
  { type, message, task_id, project_id, comment_id }
) {
  if (!EMAIL_NOTIFICATIONS_ENABLED || !mailTransporter) return;

  try {
    const user = await getUserById(userId);
    if (!user?.email) return;

    const subject = `[TaskManager] ${type}`;
    const bodyLines = [
      message,
      "",
      task_id ? `Task ID: ${task_id}` : "",
      project_id ? `Project ID: ${project_id}` : "",
      comment_id ? `Comment ID: ${comment_id}` : "",
    ].filter(Boolean);

    await mailTransporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: user.email,
      subject,
      text: bodyLines.join("\n"),
    });
  } catch (err) {
    console.error("Email notification error:", err.message);
  }
}

// ─────────────────────────────
// Main public API
// ─────────────────────────────

/**
 * Create a notification in DB + emit via Socket.IO + push to Slack
 * and mirror to the "Project Manager" internal chat channel.
 */
export async function notifyUser({
  user_id,
  type,
  message,
  task_id = null,
  project_id = null,
  comment_id = null,
}) {
  if (!user_id) return null;

  // 1) Save in DB
  const notification = await repoCreateNotification({
    user_id,
    type,
    message,
    task_id,
    project_id,
    comment_id,
  });

  // 2) Realtime via Socket.IO to that user
  try {
    const io = getIO();
    io.to(String(user_id)).emit("notification", notification);
  } catch (err) {
    console.error("Socket emit error:", err.message);
  }

  // 3) Slack + internal "Project Manager" chat mirror
  try {
    const slackText = await buildSlackText({
      user_id,
      type,
      message,
      task_id,
      project_id,
      comment_id,
    });

    // Mirror into internal chat group
    try {
      await mirrorProjectNotificationToChat({
        text: slackText,
        userId: user_id,
      });
    } catch (err) {
      console.error("Project Manager chat mirror failed:", err.message);
    }

    // Send to Slack
    await sendSlackWebhook(slackText);
  } catch (err) {
    console.error("Slack / chat mirror build error:", err.message);
  }

  // 4) Optional email
  sendEmailNotification(user_id, {
    type,
    message,
    task_id,
    project_id,
    comment_id,
  });

  return notification;
}

// List + read helpers

export async function getUserNotifications(
  userId,
  { unreadOnly = false } = {}
) {
  return getNotificationsByUser(userId, { unreadOnly });
}

export async function markOneRead(id, userId) {
  return markNotificationRead(id, userId);
}

export async function markAllRead(userId) {
  await markAllNotificationsRead(userId);
}
