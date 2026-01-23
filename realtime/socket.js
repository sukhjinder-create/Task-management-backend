// src/realtime/socket.js
// Workspace-aware Socket.IO server that preserves legacy behavior.
// Backwards compatible: keeps legacy room names and emits, while also
// adding optional workspace-scoped rooms for newer clients.

import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import pool from "../db.js";

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


import {
  createHuddle,
  getActiveHuddle,
  endHuddle,
} from "../services/huddle.service.js";

import workspaceService from "../services/workspace.service.js";
import { registerAiSocket } from "./ai.socket.js";  // import AI socket handler

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

  // 🔔 Presence update (workspace-scoped)
  io.emit("presence:update", {
    userId,
    username,
    status: "online",
    at: new Date().toISOString(),
    workspaceId: socket.workspaceId,
  });

/* -----------------------------------------------------
   🔥 FETCH HISTORY ON CHANNEL OPEN (CHANNELS + DMs)
----------------------------------------------------- */
socket.on("chat:open", async (channelKey) => {
  if (!channelKey) return;
  if (socket.disconnected || socket._isCleanedUp) return;

  const workspaceId = socket.workspaceId;

  try {
    let rows = [];

    /* =================================================
       ✅ CASE 1: DIRECT MESSAGES (dm:*)
       - No chat_channels row
       - channel_id IS the dm key
    ================================================= */
    if (channelKey.startsWith("dm:")) {
  const res = await pool.query(
    `
    SELECT
      m.*,
      u.username
    FROM chat_messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_key = $1
      AND (m.workspace_id = $2)
      AND m.deleted_at IS NULL
    ORDER BY m.created_at ASC
    LIMIT 100
    `,
    [channelKey, workspaceId]
  );

  rows = res.rows;
}

    /* =================================================
       ✅ CASE 2: WORKSPACE CHANNELS (team-general, etc.)
    ================================================= */
    else {
      const channel = await getChannelByKey(channelKey, workspaceId);
      if (!channel) {
        console.warn(
          "[chat:open] channel not found",
          channelKey,
          workspaceId
        );
        return;
      }

      const res = await pool.query(
  `
  SELECT
    m.*,
    u.username
  FROM chat_messages m
  JOIN users u ON u.id = m.user_id
  WHERE m.channel_key = $1
    AND (m.workspace_id = $2)
    AND m.deleted_at IS NULL
  ORDER BY m.created_at ASC
  LIMIT 100
  `,
  [channel.key, workspaceId]
);

      rows = res.rows;
    }

    /* =================================================
       ✅ EMIT HISTORY (COMMON FORMAT)
    ================================================= */
    socket.emit("chat:history", {
      channelId: channelKey, // 🔑 frontend ALWAYS uses key
      workspaceId,
      messages: rows.map((m) => ({
        id: m.id,
        channelId: channelKey,
        userId: m.user_id,
        username: m.username,
        textHtml: m.text_html,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        deletedAt: m.deleted_at,
        reactions: m.reactions || {},
        attachments: m.attachments || [],
        encrypted: m.encrypted_json,
        fallbackText: m.fallback_text,
        senderPublicKeyJwk: m.sender_public_key,
      })),
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

        if (!socket.disconnected && !socket._isCleanedUp) {
          socket.to(legacyRoom).emit("chat:system", {
            type: "join",
            channelId: channelKey,
            workspaceId: resolvedWorkspaceId,
            userId,
            username,
            at: new Date().toISOString(),
          });

          socket.to(wsRoom).emit("chat:system", {
            type: "join",
            channelId: channelKey,
            workspaceId: resolvedWorkspaceId,
            userId,
            username,
            at: new Date().toISOString(),
          });
        }
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

    socket.to(legacyRoom).emit("chat:system", {
      type: "leave",
      channelId: channelKey,
      workspaceId,
      userId,
      username,
      at: new Date().toISOString(),
    });

    socket.to(wsRoom).emit("chat:system", {
      type: "leave",
      channelId: channelKey,
      workspaceId,
      userId,
      username,
      at: new Date().toISOString(),
    });
  });

  /* -----------------------------------------------------
     CHAT: MESSAGE
  ----------------------------------------------------- */
 socket.on("chat:message", async ({ channelId, text, tempId, parentId }) => {
  if (socket.disconnected || socket._isCleanedUp) return;
  if (!channelId || !text?.trim()) return;

  try {
    const workspaceId = socket.workspaceId;
    const isDM = channelId.startsWith("dm:");

    let channel = null;

    // 1️⃣ Resolve channel ONLY if NOT a DM
    if (!isDM) {
      channel = await getChannelByKey(channelId, workspaceId);
      if (!channel) {
        socket.emit("chat:error", { error: "Channel does not exist" });
        return;
      }

      // Private channel membership check
      if (channel.isPrivate || channel.is_private) {
        const member = await isChannelMember(channel.id, userId).catch(() => false);
        if (!member) {
          socket.emit("chat:error", {
            error: "You are not a member of this private channel.",
          });
          return;
        }
      }

      // Ensure membership for normal channels
      await ensureChannelMember(channel.id, userId);
    }

    // 2️⃣ Persist message (SINGLE authoritative insert)
    const encryptedJson = text.trim();

    console.log("🔥 SAVING MESSAGE", {
      channelId,
      workspaceId,
      isDM,
    });

    const saved = await createChatMessage({
      channelKey: channelId,
      userId,
      textHtml: encryptedJson,
      encryptedJson,
      fallbackText: null,
      parentId: parentId || null,
      workspaceId,
    });

    if (socket.disconnected || socket._isCleanedUp) return;

    // 3️⃣ Emit (non-authoritative)
    const payload = {
      id: saved.id,
      tempId: tempId || null,
      channelId,
      workspaceId: saved.workspace_id,
      userId,
      username,
      textHtml: saved.text_html,
      createdAt: saved.created_at,
      updatedAt: saved.updated_at,
      deletedAt: saved.deleted_at,
      reactions: saved.reactions || {},
      attachments: saved.attachments || [],
    };

    // Ensure payload includes 'to' property, which could be the user or room
    payload.to = channelId;  // or target user in case of DM, if required

    io.to(legacyRoomName(channelId)).emit("chat:message", payload);
    io.to(workspaceRoomName(channelId, saved.workspace_id)).emit("chat:message", payload);
  } catch (err) {
    console.error("chat:message error:", err);
  }
});

  /* -----------------------------------------------------
     CHAT: EDIT / DELETE
  ----------------------------------------------------- */
  socket.on("chat:edit", async ({ channelId, messageId, text }) => {
    if (!channelId || !messageId || !text?.trim()) return;

    try {
      const updated = await updateChatMessage({
        messageId,
        userId,
        textHtml: text.trim(),
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

      io.to(legacyRoomName(channelId)).emit(
        "chat:messageEdited",
        payload
      );
      io.to(workspaceRoomName(channelId, workspaceId)).emit(
        "chat:messageEdited",
        payload
      );
    } catch (err) {
      console.error("chat:edit error:", err.message);
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
  socket.on("chat:reaction", (payload) => {
    const out = {
      ...payload,
      userId,
      username,
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    };
    io.to(legacyRoomName(payload.channelId)).emit(
      "chat:reaction",
      out
    );
    io.to(
      workspaceRoomName(payload.channelId, out.workspaceId)
    ).emit("chat:reaction", out);
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

    io.to(legacyRoomName(channelId)).emit(
      "huddle:started",
      out
    );
    io.to(workspaceRoomName(channelId, workspaceId)).emit(
      "huddle:started",
      out
    );
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
  };

  // 🔥 Emit unchanged behavior
  io.emit("chat:message", payload);

  if (resolvedWorkspaceId) {
    io.to(
      workspaceRoomName(resolvedChannelKey, resolvedWorkspaceId)
    ).emit("chat:message", payload);
  }
}
