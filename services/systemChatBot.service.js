// services/systemChatBot.service.js
// Helper utilities to mirror important events (attendance, tasks, projects)
// into dedicated internal chat channels.

import {
  getOrCreateChannelByKey,
  createChatMessage,
} from "./chat.service.js";
import { emitMessage } from "../realtime/socket.js";

// Canonical keys/names for your permanent groups
const AVAILABILITY_CHANNEL_KEY = "availability-updates";
const AVAILABILITY_CHANNEL_NAME = "Availability Updates";

const PROJECT_MANAGER_CHANNEL_KEY = "project-manager";
const PROJECT_MANAGER_CHANNEL_NAME = "Project Manager";

/**
 * Low-level helper: make sure a (public) channel exists and
 * append a message to it, then emit via socket.io.
 *
 * - channelKey: stable identifier (used by socket + DB)
 * - channelName: human label
 * - text: plain text that you are already sending to Slack
 * - userId: the user who triggered it (sign in, task action, etc.)
 */
async function postSystemMessageToChannel({
  channelKey,
  channelName,
  text,
  userId,
}) {
  if (!text) return;

  if (!userId) {
    // We can still create the channel, but we skip message to avoid
    // foreign-key issues if user_id is required.
    console.warn(
      `[systemChatBot] Missing userId for "${channelKey}" message, skipping chat mirror.`
    );
    return;
  }

  // Ensure a NON-PRIVATE channel exists; creator is the triggering user
  const channel = await getOrCreateChannelByKey({
    key: channelKey,
    type: "channel",
    name: channelName,
    createdBy: userId,
  });

  const html = text.replace(/\n/g, "<br>");

  // Store as a regular chat message from that user
  const message = await createChatMessage({
    channelId: channel.id,
    userId,
    textHtml: html,
    parentId: null,
    encryptedJson: null,
    fallbackText: text,
  });

  // Broadcast in real time
  try {
    const keyForEmit = channel.key || channelKey;
    emitMessage(keyForEmit, message);
  } catch (err) {
    console.error(
      "[systemChatBot] Failed to emit system chat message:",
      err.message
    );
  }

  return message;
}

// Public helpers

export async function mirrorAvailabilityToChat({ text, userId }) {
  return postSystemMessageToChannel({
    channelKey: AVAILABILITY_CHANNEL_KEY,
    channelName: AVAILABILITY_CHANNEL_NAME,
    text,
    userId,
  });
}

export async function mirrorProjectNotificationToChat({ text, userId }) {
  return postSystemMessageToChannel({
    channelKey: PROJECT_MANAGER_CHANNEL_KEY,
    channelName: PROJECT_MANAGER_CHANNEL_NAME,
    text,
    userId,
  });
}
