// services/slack.service.js
import dotenv from "dotenv";

dotenv.config();

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || null;
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "http://localhost:5173";

/**
 * Safely send a message to Slack via incoming webhook.
 * If SLACK_WEBHOOK_URL is not set, this becomes a no-op.
 */
export async function sendSlackNotification({
  user_id,
  type,
  message,
  task_id = null,
  project_id = null,
}) {
  if (!SLACK_WEBHOOK_URL) {
    // Slack not configured → silently skip
    return;
  }

  try {
    // Build a simple link back into the app
    let appLink = FRONTEND_BASE_URL;
    if (project_id && task_id) {
      // you don’t have a dedicated task URL, so go to project details
      appLink = `${FRONTEND_BASE_URL}/projects/${project_id}`;
    } else if (project_id) {
      appLink = `${FRONTEND_BASE_URL}/projects/${project_id}`;
    } else if (task_id) {
      // fallback: My Tasks
      appLink = `${FRONTEND_BASE_URL}/my-tasks`;
    }

    const titleByType = {
      project_assigned: "Project assigned",
      task_assigned: "Task assigned",
      task_updated: "Task updated",
      task_deleted: "Task deleted",
      comment_added: "New comment",
    };

    const title = titleByType[type] || "Notification";

    const text = `🔔 *${title}*\n${message}${
      appLink ? `\n<${appLink}|Open in TaskManager>` : ""
    }`;

    // Node 22 has global fetch
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Slack notification error:", err.message);
  }
}
