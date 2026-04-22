// src/realtime/socket.js
// Workspace-aware Socket.IO server that preserves legacy behavior.
// Backwards compatible: keeps legacy room names and emits, while also
// adding optional workspace-scoped rooms for newer clients.
import pool from "../db.js";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import {
  ensureChannelMember,
  createChatMessage,
  updateChatMessage,
  softDeleteChatMessage,
  isChannelMember,
} from "../services/chat.service.js";

import {
  getChannelByKey,
  getRecentMessagesResolved,
} from "../services/chat.service.js";

import { sendPushToUser } from "../services/push.service.js";


import {
  createHuddle,
  getActiveHuddle,
  endHuddle,
} from "../services/huddle.service.js";

import workspaceService from "../services/workspace.service.js";
import { registerAiSocket } from "./ai.socket.js";  // import AI socket handler
import { recomputeWorkspaceHealth } from "../services/workspaceHealth.service.js";

let io;
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";
const WORKSPACE_GLOBAL = "GLOBAL";

/**
 * For DM channels we use key pattern:
 *   dm:<uidSmall>:<uidBig>
 */
function getChannelMetaFromKey(channelKey) {
  if (channelKey === "general") return { type: "public", name: "#general" };
  if (channelKey.startsWith("dm:")) return { type: "dm", name: "Direct message" };
  if (channelKey.startsWith("thread:")) return { type: "thread", name: "Thread" };
  return { type: "public", name: channelKey };
}

function legacyRoomName(channelKey) {
  return `channel:${channelKey}`;
}
function workspaceRoomName(channelKey, workspaceId = WORKSPACE_GLOBAL) {
  const ws = workspaceId || WORKSPACE_GLOBAL;
  return `workspace:${ws}:channel:${channelKey}`;
}

function extractPlainText(input) {
  if (!input) return "";

  // If encrypted JSON string, try extracting fallbackText
  if (typeof input === "string" && input.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed?.fallbackText === "string") {
        return parsed.fallbackText.trim();
      }
    } catch {
      // ignore parse errors
    }
  }

  // Otherwise assume normal HTML/text
  return input
    .replace(/<[^>]*>/g, "")
    .trim();
}

function resolveRenderableText(m) {
  if (m.updated_at && m.text_html) {
    return m.text_html;
  }
  // 1️⃣ Plain text (legacy)
  if (m.text_html && typeof m.text_html === "string" && !m.text_html.startsWith("{")) {
    return m.text_html;
  }

  // 2️⃣ Explicit fallback_text column
  if (m.fallback_text) {
    return m.fallback_text;
  }

  // 3️⃣ Encrypted JSON → extract fallbackText
  if (m.encrypted_json?.message) {
    try {
      const parsed =
        typeof m.encrypted_json.message === "string"
          ? JSON.parse(m.encrypted_json.message)
          : m.encrypted_json.message;

      if (typeof parsed?.fallbackText === "string") {
        return parsed.fallbackText;
      }
    } catch {
      return "";
    }
  }

  return "";
}

// utils / local helper
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

/* -------------------------------------------------------
   INIT SOCKET WITH FRONTEND URL
------------------------------------------------------- */
export function initSocket(server, frontendUrl) {
  io = new Server(server, {
    cors: {
      origin: frontendUrl || process.env.FRONTEND_BASE_URL,
      credentials: true,
    },
  });

// Register AI socket listeners
  registerAiSocket(io);  // THIS is where AI gets integrated

  /* -----------------------------------------------------
     AUTH MIDDLEWARE
  ----------------------------------------------------- */
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized: no token"));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      socket.user = {
        ...decoded,
        workspaceId: decoded.workspaceId || WORKSPACE_GLOBAL,
      };

      if (
        socket.user.workspaceId === WORKSPACE_GLOBAL &&
        workspaceService?.getMembershipByUserId
      ) {
        try {
          const membership =
            await workspaceService.getMembershipByUserId(String(decoded.id));
          if (membership?.workspace_id) {
            socket.user.workspaceId = membership.workspace_id;
          }
        } catch (err) {
          console.error(
            "Socket workspace resolution failed:",
            err.message
          );
        }
      }

      next();
    } catch (err) {
      console.error("Socket auth error", err.message);
      next(new Error("Unauthorized: invalid token"));
    }
  });

  io.on("connection", async (socket) => {
  const userId = socket.user.id;
  const username = socket.user.username;
  // 🔐 Prevent duplicate sends from same socket
socket._recentMessageHashes = new Set();

  // 🔐 Always keep real workspaceId from JWT
  socket.workspaceId = socket.user.workspaceId || null;

  // 🔐 Internal lifecycle guard (used by async handlers)
  socket._isCleanedUp = false;

  // 🔁 Resolve workspace ONLY if missing (legacy safety)
  if (!socket.workspaceId && workspaceService?.getMembershipByUserId) {
    try {
      const membership =
        await workspaceService.getMembershipByUserId(String(userId));
      if (membership?.workspace_id) {
        socket.workspaceId = membership.workspace_id;
      }
    } catch (err) {
      console.error(
        "Failed to resolve workspace for socket:",
        err.message
      );
    }
  }

  // 🔐 HARD ASSERT — socket must belong to a workspace
  if (!socket.workspaceId) {
    console.error(
      "Socket connected without workspace. Disconnecting.",
      { userId }
    );
    socket.disconnect(true);
    return;
  }

  // 🔁 Personal room (for direct emits)
socket.join(userId);

console.log(
  "Socket connected for user:",
  userId,
  "workspace:",
  socket.workspaceId
);

/* =====================================================
   🧠 WORKSPACE CONTROL CENTER ROOM (ADD THIS BLOCK)
   ===================================================== */
if (socket.workspaceId) {
  const workspaceRoom = `workspace:${socket.workspaceId}`;

  socket.join(workspaceRoom);

  console.log(
    "🧠 Joined workspace intelligence room:",
    workspaceRoom
  );
}

  // 🔔 Presence update (workspace-scoped)
  io.emit("presence:update", {
    userId,
    username,
    status: "online",
    at: new Date().toISOString(),
    workspaceId: socket.workspaceId,
  });

  /* -----------------------------------------------------
   WORKSPACE: SUBSCRIBE (FOR DASHBOARD & INTELLIGENCE)
----------------------------------------------------- */
socket.on("workspace:subscribe", () => {
  if (!socket.workspaceId) return;

  const workspaceRoom = `workspace:${socket.workspaceId}`;
  socket.join(workspaceRoom);

  console.log("✅ Client subscribed to workspace room:", workspaceRoom);
});

/* -----------------------------------------------------
   🔥 FETCH HISTORY ON CHANNEL OPEN (CHANNELS + DMs)
----------------------------------------------------- */
socket.on("chat:open", async (channelKey) => {
  if (!channelKey) return;
  if (socket.disconnected || socket._isCleanedUp) return;

  const workspaceId = socket.workspaceId;
  // ✅ Ensure DM sockets join rooms (CRITICAL)
if (channelKey.startsWith("dm:")) {
  const legacyRoom = legacyRoomName(channelKey);
  const wsRoom = workspaceRoomName(channelKey, workspaceId);

  socket.join(legacyRoom);
  socket.join(wsRoom);
}

  try {
    const res = await pool.query(
  `
  SELECT
    m.*,
    u.username
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE m.channel_key = $1
    AND m.workspace_id = $2
    AND m.deleted_at IS NULL
  ORDER BY m.created_at DESC
  LIMIT 100
  `,
  [channelKey, workspaceId]
);
const rows = res.rows;
const orderedRows = rows.reverse();
socket.emit("chat:history", {
  channelId: channelKey,
  workspaceId,
  messages: orderedRows.map((m) => {
    // Detect AI-generated messages via the __from_ai flag stored in encrypted_json
    let isAiMessage = false;
    try {
      const enc = typeof m.encrypted_json === "string"
        ? JSON.parse(m.encrypted_json)
        : m.encrypted_json;
      isAiMessage = enc?.__from_ai === true;
    } catch {}

    return {
      id: m.id,
      channelId: channelKey,
      userId: m.user_id,
      username: m.username,
      textHtml: resolveRenderableText(m),
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      deletedAt: m.deleted_at,
      reactions: m.reactions || {},
      attachments: m.attachments || [],
      encrypted: m.encrypted_json,
      fallbackText: m.fallback_text,
      senderPublicKeyJwk: m.sender_public_key,
      parentId: m.parent_id,
      isAiMessage,
    };
  }),
});
  } catch (err) {
    console.error("🔥 chat:open history error:", err);
  }
});

  /* -----------------------------------------------------
     CHAT: JOIN CHANNEL
  ----------------------------------------------------- */
  socket.on("chat:join", (channelKey) => {
    if (!channelKey) return;

    if (socket.disconnected || socket._isCleanedUp) return;

    (async () => {
      try {
        const meta = getChannelMetaFromKey(channelKey);
        const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

        const channel = await getChannelByKey(
          channelKey,
          socket.workspaceId
        );

        if (!channel) {
          socket.emit("chat:error", {
            error: "Channel does not exist",
          });
          return;
        }

        if (socket.disconnected || socket._isCleanedUp) return;

        const legacyRoom = legacyRoomName(channelKey);
        const wsRoom = workspaceRoomName(channelKey, workspaceId);

        socket.join(legacyRoom);
        socket.join(wsRoom);

        const resolvedWorkspaceId = socket.workspaceId;
        const active = await getActiveHuddle(channelKey);
        if (active && !socket.disconnected && !socket._isCleanedUp) {
          socket.emit("huddle:started", {
            channelId: channelKey,
            workspaceId: channel.workspaceId || resolvedWorkspaceId,
            huddleId: active.huddle_id,
            startedBy: {
              userId: active.started_by,
              username: active.started_by ? "User" : "Unknown",
            },
            at: active.started_at,
            persisted: true,
          });
        }

        // join/leave system messages intentionally suppressed
      } catch (err) {
        console.error("🔥 chat:join error", {
          socketId: socket.id,
          userId,
          channelKey,
          error: err,
        });
      }
    })();
  });

  /* -----------------------------------------------------
     CHAT: LEAVE
  ----------------------------------------------------- */
  socket.on("chat:leave", (channelKey) => {
    if (!channelKey) return;

    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const legacyRoom = legacyRoomName(channelKey);
    const wsRoom = workspaceRoomName(channelKey, workspaceId);

    socket.leave(legacyRoom);
    socket.leave(wsRoom);

    // join/leave system messages intentionally suppressed
  });

  /* -----------------------------------------------------
     CHAT: MESSAGE
  ----------------------------------------------------- */
 socket.on("chat:message", async (data, ack) => {
  const { channelId, text, tempId, parentId, attachments } = data || {};
  if (socket.disconnected || socket._isCleanedUp) return;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!channelId || (!text?.trim() && !hasAttachments)) return;

  const workspaceId = socket.workspaceId;
  const cleanText = text.trim();

  // 🔐 HARD DEDUPLICATION (same socket, same message)
  const dedupeKey = `${channelId}::${cleanText}::${parentId || "root"}`;

  if (socket._recentMessageHashes.has(dedupeKey)) {
    console.warn("⚠️ Duplicate chat:message ignored", dedupeKey);
    return;
  }

  socket._recentMessageHashes.add(dedupeKey);

  // auto-expire after 3s (covers double enter / resend / reconnect)
  setTimeout(() => {
    socket._recentMessageHashes.delete(dedupeKey);
  }, 3000);

  try {
    const isDM = channelId.startsWith("dm:");

    // ✅ ONLY validate channel for non-DM
    if (!isDM) {
      const channel = await getChannelByKey(channelId, workspaceId);
      if (!channel) {
        socket.emit("chat:error", { error: "Channel does not exist" });
        return;
      }

      if (channel.isPrivate || channel.is_private) {
        const member = await isChannelMember(channel.id, userId);
        if (!member) {
          socket.emit("chat:error", {
            error: "You are not a member of this private channel.",
          });
          return;
        }
      }

      await ensureChannelMember(channel.id, userId);
    }

    console.log("🔥 SAVING MESSAGE", { channelId, workspaceId, isDM });

    // 🔥 SINGLE SOURCE OF TRUTH (DB → socket emit happens elsewhere)
    const saved = await createChatMessage({
      channelKey: channelId,
      userId,
      tempId: tempId || null,
      textHtml: cleanText,
      parentId: parentId || null,
      attachments: Array.isArray(attachments) ? attachments : [],
      workspaceId,
    });

    // ✅ Confirm save to sender — frontend uses this to cancel its fallback timer
    if (typeof ack === "function") ack({ ok: true, tempId: tempId || null });

    // Push notification to other channel members (non-blocking)
    try {
      let targetUserIds = [];
      if (isDM) {
        targetUserIds = channelId.split(":").slice(1).filter((id) => id !== String(userId));
      } else {
        const { rows: members } = await pool.query(
          "SELECT user_id FROM chat_channel_members WHERE channel_id = (SELECT id FROM chat_channels WHERE key = $1 LIMIT 1) AND user_id != $2",
          [channelId, userId]
        );
        targetUserIds = members.map((m) => m.user_id);
      }
      console.log(`[push:chat:socket] isDM=${isDM} channelId=${channelId} sender=${userId} targets=${JSON.stringify(targetUserIds)}`);
      const senderName = saved?.username || username || "Someone";
      for (const targetId of targetUserIds) {
        sendPushToUser({
          userId: targetId,
          title: isDM ? senderName : `${senderName} in #${channelId}`,
          body: "Sent a message",
          url: "/chat",
          type: "chat",
        }).catch((e) => console.error("[push:chat:socket] sendPushToUser failed:", e.message));
      }
    } catch (e) {
      console.error("[push:chat:socket] error:", e.message);
    }
  } catch (err) {
    console.error("chat:message error:", err);
    if (typeof ack === "function") ack({ ok: false, error: err.message });
  }
});

  /* -----------------------------------------------------
     CHAT: EDIT / DELETE
  ----------------------------------------------------- */
socket.on("chat:edit", async ({ channelId, messageId, text }) => {
  // 🔒 HARD GUARD — never edit temp messages
  if (!messageId || !isUuid(messageId)) {
    console.warn("Ignoring edit for non-persisted message:", messageId);
    return;
  }

  if (!channelId || !text?.trim()) return;

  try {
    const plainText = extractPlainText(text);

    const encryptedPayload =
      typeof text === "string" && text.trim().startsWith("{")
        ? JSON.parse(text)
        : { message: plainText };

    const updated = await updateChatMessage({
      messageId,
      workspaceId: socket.workspaceId, // ✅ REQUIRED
      textHtml: plainText,
      fallbackText: plainText,
      encryptedJson: encryptedPayload,
    });

    if (!updated) return;

    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

    const payload = {
      id: updated.id,
      channelId,
      workspaceId,
      userId: updated.user_id,
      username,
      textHtml: updated.text_html,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };

    io.to(legacyRoomName(channelId)).emit("chat:messageEdited", payload);
    io.to(workspaceRoomName(channelId, workspaceId)).emit(
      "chat:messageEdited",
      payload
    );
  } catch (err) {
    console.error("chat:edit error:", err);
  }
});

  socket.on("chat:delete", async ({ channelId, messageId }) => {
    if (!channelId || !messageId) return;

    try {
      const deleted = await softDeleteChatMessage({
        messageId,
        userId,
      });

      if (!deleted) return;

      const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

      const payload = {
        id: deleted.id,
        channelId,
        workspaceId,
        userId: deleted.user_id,
        username,
        deletedAt: deleted.deleted_at,
      };

      io.to(legacyRoomName(channelId)).emit(
        "chat:messageDeleted",
        payload
      );
      io.to(workspaceRoomName(channelId, workspaceId)).emit(
        "chat:messageDeleted",
        payload
      );
    } catch (err) {
      console.error("chat:delete error:", err.message);
    }
  });

  /* -----------------------------------------------------
     REACTIONS / TYPING / READ
  ----------------------------------------------------- */
  socket.on("chat:reaction", async (payload) => {
  const { channelId, messageId } = payload;
  if (!channelId || !messageId) return;

  try {
    // 1️⃣ Load current reactions
    const { rows } = await pool.query(
      `SELECT reactions FROM chat_messages WHERE id = $1 LIMIT 1`,
      [messageId]
    );
    if (!rows.length) return;

    const current = rows[0].reactions || {};
    const { emoji, action } = payload;

    const r = current[emoji] || { userIds: [] };
    const set = new Set(r.userIds || []);

    if (action === "add") set.add(userId);
    if (action === "remove") set.delete(userId);

    if (set.size === 0) {
      delete current[emoji];
    } else {
      current[emoji] = {
        count: set.size,
        userIds: Array.from(set),
      };
    }

    // 2️⃣ Persist to DB
    await pool.query(
      `UPDATE chat_messages SET reactions = $1 WHERE id = $2`,
      [current, messageId]
    );

    // 3️⃣ Emit (unchanged behavior)
    const out = {
      ...payload,
      userId,
      username,
      reactions: current,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };

    io.to(legacyRoomName(channelId)).emit("chat:reaction", out);
    io
      .to(workspaceRoomName(channelId, out.workspaceId))
      .emit("chat:reaction", out);
  } catch (err) {
    console.error("chat:reaction error:", err);
  }
});

  socket.on("chat:typing", ({ channelId }) => {
    const out = {
      channelId,
      userId,
      username,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };
    socket.to(legacyRoomName(channelId)).emit("chat:typing", out);
    socket
      .to(workspaceRoomName(channelId, out.workspaceId))
      .emit("chat:typing", out);
  });

  socket.on("chat:read", ({ channelId, at }) => {
    const out = {
      channelId,
      userId,
      username,
      at: at || new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };
    socket.to(legacyRoomName(channelId)).emit("chat:read", out);
    socket
      .to(workspaceRoomName(channelId, out.workspaceId))
      .emit("chat:read", out);
  });

  /* -----------------------------------------------------
     HUDDLES
  ----------------------------------------------------- */
  socket.on("huddle:start", async ({ channelId, huddleId }) => {
    if (!channelId || !huddleId) return;

    const existing = await getActiveHuddle(channelId);
    if (existing) return;

    await createHuddle({
      channelKey: channelId,
      huddleId,
      startedBy: userId,
    });

    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = {
      channelId,
      workspaceId,
      huddleId,
      startedBy: { userId, username },
      at: new Date().toISOString(),
      persisted: true,
    };

    // Broadcast to channel rooms AND entire workspace so all members get the invite
    io.to(legacyRoomName(channelId)).emit("huddle:started", out);
    io.to(workspaceRoomName(channelId, workspaceId)).emit("huddle:started", out);
    io.to(`workspace:${workspaceId}`).emit("huddle:started", out);

    // Send FCM push notification to all workspace members (except starter)
    try {
      const { rows: members } = await pool.query(
        "SELECT user_id FROM workspace_users WHERE workspace_id = $1 AND user_id != $2",
        [workspaceId, userId]
      );
      const channelLabel = channelId.startsWith("dm:") ? "Direct Message" : `#${channelId}`;
      for (const member of members) {
        sendPushToUser({
          userId: member.user_id,
          title: `📞 ${username} is calling`,
          body: `Incoming huddle in ${channelLabel}`,
          url: "/chat",
          type: "huddle",
          extraData: { huddleId, channelId, startedByName: username, startedBy: String(userId) },
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[push:huddle] error:", e.message);
    }
  });

  socket.on("huddle:end", async ({ channelId, huddleId }) => {
    if (!channelId || !huddleId) return;
    await endHuddle({ channelKey: channelId, huddleId });

    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = {
      channelId,
      workspaceId,
      huddleId,
      endedBy: { userId, username },
      at: new Date().toISOString(),
    };

    io.to(legacyRoomName(channelId)).emit("huddle:ended", out);
    io.to(workspaceRoomName(channelId, workspaceId)).emit(
      "huddle:ended",
      out
    );
  });

  socket.on("huddle:join", ({ channelId, huddleId }) => {
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = {
      channelId,
      workspaceId,
      huddleId,
      userId,
      username,
      at: new Date().toISOString(),
    };
    socket
      .to(legacyRoomName(channelId))
      .emit("huddle:user-joined", out);
    socket
      .to(workspaceRoomName(channelId, workspaceId))
      .emit("huddle:user-joined", out);
  });

  socket.on("huddle:leave", ({ channelId, huddleId }) => {
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = {
      channelId,
      workspaceId,
      huddleId,
      userId,
      username,
      at: new Date().toISOString(),
    };
    socket
      .to(legacyRoomName(channelId))
      .emit("huddle:user-left", out);
    socket
      .to(workspaceRoomName(channelId, workspaceId))
      .emit("huddle:user-left", out);
  });

  /* -----------------------------------------------------
     HUDDLE SIGNALING
  ----------------------------------------------------- */
  socket.on(
    "huddle:signal",
    ({ channelId, targetUserId, huddleId, data }) => {
      if (!channelId || !targetUserId || !huddleId || !data) return;

      io.to(targetUserId).emit("huddle:signal", {
        channelId,
        huddleId,
        fromUserId: userId,
        toUserId: targetUserId,
        data,
        workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
      });
    }
  );

  /* -----------------------------------------------------
     HUDDLE MEDIA STATE BROADCASTS
  ----------------------------------------------------- */
  socket.on("huddle:mute", ({ channelId }) => {
    if (!channelId) return;
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = { channelId, userId, username };
    socket.to(legacyRoomName(channelId)).emit("huddle:mute", out);
    socket.to(workspaceRoomName(channelId, workspaceId)).emit("huddle:mute", out);
  });

  socket.on("huddle:unmute", ({ channelId }) => {
    if (!channelId) return;
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = { channelId, userId, username };
    socket.to(legacyRoomName(channelId)).emit("huddle:unmute", out);
    socket.to(workspaceRoomName(channelId, workspaceId)).emit("huddle:unmute", out);
  });

  socket.on("huddle:screen-start", ({ channelId }) => {
    if (!channelId) return;
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = { channelId, userId, username };
    socket.to(legacyRoomName(channelId)).emit("huddle:screen-start", out);
    socket.to(workspaceRoomName(channelId, workspaceId)).emit("huddle:screen-start", out);
  });

  socket.on("huddle:screen-stop", ({ channelId }) => {
    if (!channelId) return;
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = { channelId, userId, username };
    socket.to(legacyRoomName(channelId)).emit("huddle:screen-stop", out);
    socket.to(workspaceRoomName(channelId, workspaceId)).emit("huddle:screen-stop", out);
  });

  socket.on("huddle:mute-all", ({ channelId }) => {
    if (!channelId) return;
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;
    const out = { channelId, byUserId: userId };
    socket.to(legacyRoomName(channelId)).emit("huddle:muted", out);
    socket.to(workspaceRoomName(channelId, workspaceId)).emit("huddle:muted", out);
  });

  /* -----------------------------------------------------
     PRESENCE
  ----------------------------------------------------- */
  socket.on("presence:set", (status) => {
    if (!status) return;
    io.emit("presence:update", {
      userId,
      username,
      status,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    });
  });

  /* -----------------------------------------------------
     DISCONNECT — CLEAN LIFECYCLE ✅ FIXED LOCATION
  ----------------------------------------------------- */
  socket.on("disconnect", () => {
    socket._isCleanedUp = true;

    console.log("Socket disconnected:", userId);

    io.emit("presence:update", {
      userId,
      username,
      status: "offline",
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId,
    });
  });
});

  async function safeSocketDbExec(socket, fn, context = "unknown") {
  if (!socket || socket.disconnected) return;

  try {
    await fn();
  } catch (err) {
    console.error(`🔥 Socket DB error [${context}]`, {
      socketId: socket.id,
      error: err,
    });
  }
 }
}


/* -----------------------------------------------------
   EXPORT IO + helper emits
----------------------------------------------------- */
export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}

/* =====================================================
   🧠 WORKSPACE INTELLIGENCE EMITTER
   ===================================================== */

export async function emitWorkspaceIntelligenceUpdate(workspaceId, payload) {
  const room = `workspace:${workspaceId}`;

  const newHealth = await recomputeWorkspaceHealth(workspaceId);

  io.to(room).emit("workspace:intelligence-updated", payload);

  io.to(room).emit("workspace:health-pulse", {
    health: newHealth,
    at: new Date().toISOString(),
  });
}

/**
 * Emitted when a superadmin changes a workspace's billing plan.
 * All connected users in that workspace re-fetch their plan features.
 */
export function emitPlanUpdated(workspaceId, planSlug) {
  if (!io) return;
  io.to(`workspace:${workspaceId}`).emit("workspace:plan_updated", {
    workspaceId,
    plan: planSlug,
  });
}

export function emitChannelCreated(channel, workspaceId = WORKSPACE_GLOBAL) {
  if (!io) return;

  const key = channel?.key || channel?.id || "unknown";
  const legacyRoom = legacyRoomName(key);
  const wsRoom = workspaceRoomName(key, workspaceId);

  io.to(legacyRoom).emit("chat:channel_created", channel);
  io.to(wsRoom).emit("chat:channel_created", channel);
}

export function emitMemberAdded(
  channelId,
  userId,
  workspaceId = WORKSPACE_GLOBAL
) {
  if (!io) return;
  io.to(userId).emit("chat:added_to_channel", { channelId, workspaceId });
  io.to(legacyRoomName(channelId)).emit("chat:member_added", {
    channelId,
    userId,
    workspaceId,
  });
  io.to(workspaceRoomName(channelId, workspaceId)).emit(
    "chat:member_added",
    {
      channelId,
      userId,
      workspaceId,
    }
  );
}

export function emitMessage(channelKey, message, workspaceId = WORKSPACE_GLOBAL) {
  if (!io) return;

  // 🔒 BACKWARD-COMPAT SAFETY:
  // allow old calls: emitMessage(message, workspaceId)
  if (typeof channelKey === "object" && channelKey !== null) {
    workspaceId = message || channelKey.workspaceId || channelKey.workspace_id || workspaceId;
    message = channelKey;
    channelKey =
      message.channelId ||
      message.channel_key ||
      message.channel ||
      null;
  }

  if (!message || !channelKey) return;

   // 🧪 DEBUG LOG — PASTE THIS LINE
  console.log(
    "[emitMessage]",
    "channelKey:",
    channelKey,
    "messageId:",
    message.id,
    "workspaceId:",
    workspaceId
  );

  // 🔒 SAFETY: ensure channelKey is always a string
  const resolvedChannelKey =
    typeof channelKey === "string"
      ? channelKey
      : message.channelId ||
        message.channel_key ||
        message.channel ||
        null;

  if (!resolvedChannelKey) return;

  // 🔒 SAFETY: ensure text is not dropped (AI messages rely on this)
  const resolvedText =
    message.textHtml ||
    message.text_html ||
    message.text ||
    message.fallbackText ||
    message.fallback_text ||
    "";

  const resolvedWorkspaceId =
    message.workspaceId || message.workspace_id || workspaceId;

  const payload = {
    id: message.id || message.tempId || message.message_id || null,
    tempId: message.tempId || null,
    channelId: resolvedChannelKey,
    workspaceId: resolvedWorkspaceId,
    userId: message.userId || message.user_id,
    username: message.username,
    textHtml: resolvedText,
    createdAt:
      message.createdAt || message.created_at || new Date().toISOString(),
    updatedAt: message.updatedAt || message.updated_at || null,
    deletedAt: message.deletedAt || message.deleted_at || null,
    reactions: message.reactions || {},
    attachments: message.attachments || [],
    encrypted: message.encrypted || message.encrypted_json,
    senderPublicKeyJwk:
      message.senderPublicKeyJwk || message.sender_public_key || null,
    fallbackText: message.fallbackText || message.fallback_text || "",
    parentId: message.parentId || message.parent_id || null,
    isAiMessage: message.isAiMessage === true,
  };

io.to(workspaceRoomName(resolvedChannelKey, resolvedWorkspaceId)).emit("chat:message", payload);
}

/**
 * Emit an AI-typing indicator to a channel.
 * Called immediately when the AI starts processing a message so the sender
 * sees "AI is typing..." while waiting for the LLM response.
 */
export function emitAiTyping(channelKey, workspaceId) {
  if (!io || !channelKey || !workspaceId) return;
  const payload = { channelId: channelKey, workspaceId };
  // Emit to both rooms so every client in the DM sees the indicator,
  // regardless of which room they joined (legacy or workspace-scoped).
  io.to(legacyRoomName(channelKey)).emit("chat:ai-typing", payload);
  io.to(workspaceRoomName(channelKey, workspaceId)).emit("chat:ai-typing", payload);
}

/**
 * Emitted when the smart browser test agent hits a login wall and needs
 * the user to provide credentials before it can continue testing.
 * Frontend should listen for this event and show a credential prompt modal.
 */
export function emitTestingCredentialRequest(workspaceId, runId, loginUrl) {
  if (!io || !workspaceId || !runId) return;
  io.to(`workspace:${workspaceId}`).emit("testing:credential_request", {
    runId,
    loginUrl,
    message: "The testing agent reached a login page and needs credentials to continue.",
    timestamp: new Date().toISOString(),
  });
}
