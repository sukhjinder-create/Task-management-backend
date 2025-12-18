// services/systemChatBot.service.js
// Helper utilities to mirror important events (attendance, tasks, projects)
// into dedicated internal chat channels.
//
// Policy: workspace is determined server-side from the *acting user*.
// If a user belongs to a workspace, system messages they trigger will be
// mirrored into that workspace-specific channel. If they do not belong to
// any workspace, a global (workspace-less) channel is used.
//
// This enforces the desired UX: to access a different workspace the user
// must sign out and sign in as a different account that belongs to that workspace.
// NOTE: the DB enforces one account -> one workspace membership (uniqueness on workspace_users.user_id).

import {
  getOrCreateChannelByKey,
  createChatMessage,
} from "./chat.service.js";
import { emitMessage } from "../realtime/socket.js";
import pool from "../db.js"; // lightweight DB access to read workspace_users

// Canonical keys/names for your permanent groups
const AVAILABILITY_CHANNEL_KEY = "availability-updates";
const AVAILABILITY_CHANNEL_NAME = "Availability Updates";

const PROJECT_MANAGER_CHANNEL_KEY = "project-manager";
const PROJECT_MANAGER_CHANNEL_NAME = "Project Manager";

/**
 * Find *one* workspace id associated with the given user.
 * Choice: returns the earliest workspace the user was added to (ORDER BY created_at).
 * Because we enforce uniqueness on workspace_users.user_id, this will return at most one row.
 * If user is member of multiple workspaces (unexpected), behaviour is: pick the first one.
 * This fits the "sign out / sign in as another account" model: an account is tied to one workspace at a time.
 *
 * Returns: workspaceId string or null.
 */
async function findWorkspaceIdForUser(userId) {
  if (!userId) return null;
  try {
    const client = await pool.connect();
    try {
      // The query intentionally limits to 1 row and casts userId to string for safety.
      const res = await client.query(
        `SELECT workspace_id
         FROM workspace_users
         WHERE user_id = $1
         LIMIT 1`,
        [String(userId)]
      );
      return res.rows[0]?.workspace_id || null;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[systemChatBot] findWorkspaceIdForUser DB error:", err.message);
    return null;
  }
}

/**
 * Low-level helper: ensure channel (optionally workspace-scoped) exists and append a message to it,
 * then emit via socket.io.
 *
 * IMPORTANT:
 * - We infer workspaceId from the user who triggered the event (no client-supplied workspaceId).
 * - If the user is not member of any workspace, we use a global (workspace-less) channel.
 *
 * Args:
 *  - channelKey: stable identifier (used by socket + DB)
 *  - channelName: human label
 *  - text: plain text that you are already sending to Slack (string)
 *  - userId: the user who triggered it (sign in, task action, etc.) — REQUIRED
 *
 * Returns the stored message object (or null on error)
 */
async function postSystemMessageToChannel({
  channelKey,
  channelName,
  text,
  userId,
  workspaceId,
}) {
  if (!text || !userId) return null;

  let resolvedWorkspaceId = workspaceId;

if (!resolvedWorkspaceId || resolvedWorkspaceId === "GLOBAL") {
  resolvedWorkspaceId = await findWorkspaceIdForUser(userId);
}

if (!resolvedWorkspaceId) {
  throw new Error(
    `[SYSTEM CHAT] Cannot resolve workspace for user ${userId}`
  );
}

    console.log(
  "[SYSTEM CHAT WRITE]",
  {
    channelKey,
    userId,
    resolvedWorkspaceId,
    incomingWorkspaceId: workspaceId,
  }
);



  // 1️⃣ Ensure channel exists
  const channel = await getOrCreateChannelByKey({
    key: channelKey,
    type: "channel",
    name: channelName,
    createdBy: userId,
    workspaceId: resolvedWorkspaceId,
  });

  // 2️⃣ ALWAYS store message (no socket dependency)
  const message = await createChatMessage({
    channelId: channel.id,
    userId,
    textHtml: text.replace(/\n/g, "<br>"),
    fallbackText: text,
    workspaceId: resolvedWorkspaceId,
  });

  // 3️⃣ Emit only as a hint (optional)
  emitMessage(channel.key, message, resolvedWorkspaceId);

  return message;
}

// Public helpers (same names as before; callers do not need to change)
export async function mirrorAvailabilityToChat({
  text,
  userId,
  workspaceId,
}) {
  return postSystemMessageToChannel({
    channelKey: AVAILABILITY_CHANNEL_KEY,
    channelName: AVAILABILITY_CHANNEL_NAME,
    text,
    userId,
    workspaceId,
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
