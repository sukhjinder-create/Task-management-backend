import { notifyUser } from "../../services/notification.service.js";

/**
 * Sends a coaching nudge as a notification
 * Uses existing notification system
 */
export async function sendCoachingNotification({
  userId,
  workspaceId,
  message,
  expectedImpact,
}) {
  await notifyUser({
    user_id: userId,
    type: "ai_coaching_nudge",
    message: message,
    metadata: {
      source: "ai_coach",
      expectedImpact,
      workspaceId,
    },
  });
}
