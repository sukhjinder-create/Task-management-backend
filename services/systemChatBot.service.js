// services/systemChatBot.service.js
import {
  getChannelByKey,
  createChatMessage,
} from "./chat.service.js";
import { emitMessage } from "../realtime/socket.js";
import pool from "../db.js";

// ------------------------------------------------------------------
const AVAILABILITY_CHANNEL_KEY = "availability-updates";
const AVAILABILITY_CHANNEL_NAME = "Availability Updates";

const PROJECT_MANAGER_CHANNEL_KEY = "project-manager";
const PROJECT_MANAGER_CHANNEL_NAME = "Project Manager";

// ------------------------------------------------------------------
async function findWorkspaceIdForUser(userId) {
  if (!userId) return null;

  const res = await pool.query(
    `
    SELECT workspace_id
    FROM workspace_users
    WHERE user_id = $1
    LIMIT 1
    `,
    [String(userId)]
  );

  return res.rows[0]?.workspace_id || null;
}

// ------------------------------------------------------------------
async function postSystemMessageToChannel({
  channelKey,
  channelName,
  text,
  userId,
  workspaceId,
}) {
  if (!text || !userId) return null;

  let resolvedWorkspaceId = workspaceId;
  if (!resolvedWorkspaceId) {
    resolvedWorkspaceId = await findWorkspaceIdForUser(userId);
  }

  if (!resolvedWorkspaceId) {
    console.error("[SYSTEM CHAT] Workspace missing", {
      userId,
      channelKey,
    });
    return null;
  }

  console.log("[SYSTEM CHAT WRITE]", {
    channelKey,
    userId,
    workspaceId: resolvedWorkspaceId,
  });

 const channel = await getChannelByKey(
  channelKey,
  resolvedWorkspaceId
);

if (!channel) {
  console.error(
    "[SYSTEM CHAT] Channel does not exist:",
    channelKey
  );
  return null;
}

  if (!channel?.id) {
    console.error("[SYSTEM CHAT] Channel creation failed", {
      channelKey,
      resolvedWorkspaceId,
    });
    return null;
  }

  // 2️⃣ Build encrypted_json (REQUIRED)
  const encryptedJson = JSON.stringify({
    source: "system",
    subType: channelKey,
    text,
    userId,
    workspaceId: resolvedWorkspaceId,
    at: new Date().toISOString(),
  });

  // 3️⃣ Persist EXACTLY like normal chat
  const message = await createChatMessage({
  channelKey: channel.key,   // ✅ TEXT
  userId,
  textHtml: text.replace(/\n/g, "<br>"),
  fallbackText: text,
  encryptedJson,
  parentId: null,
  workspaceId: resolvedWorkspaceId, // ✅ REQUIRED
});

  if (!message?.id) {
    console.error("[SYSTEM CHAT] Message insert failed", {
      channelId: channel.id,
    });
    return null;
  }

  // 4️⃣ Emit (non-authoritative)
  emitMessage(channel.key, message, resolvedWorkspaceId);

  return message;
}

// ------------------------------------------------------------------
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

export async function mirrorProjectNotificationToChat({
  text,
  userId,
  workspaceId,
}) {
  return postSystemMessageToChannel({
    channelKey: PROJECT_MANAGER_CHANNEL_KEY,
    channelName: PROJECT_MANAGER_CHANNEL_NAME,
    text,
    userId,
    workspaceId,
  });
}
