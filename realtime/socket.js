// realtime/socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import {
  getOrCreateChannelByKey,
  ensureChannelMember,
  createChatMessage,
  updateChatMessage,
  softDeleteChatMessage,
  // we keep only what is actually used in this file
  isChannelMember,
  getRecentMessagesByChannelKey,
} from "../services/chat.service.js";

import {
  createHuddle,
  getActiveHuddle,
  endHuddle,
} from "../services/huddle.service.js";

let io;
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";

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

  /* -----------------------------------------------------
     AUTH MIDDLEWARE
  ----------------------------------------------------- */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized: no token"));

    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch (err) {
      console.error("Socket auth error", err.message);
      next(new Error("Unauthorized: invalid token"));
    }
  });

  /* -----------------------------------------------------
     CONNECTION
  ----------------------------------------------------- */
  io.on("connection", (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;

    socket.join(userId);
    console.log("Socket connected for user:", userId);

    io.emit("presence:update", {
      userId,
      username,
      status: "online",
      at: new Date().toISOString(),
    });

    /* -----------------------------------------------------
       CHAT: JOIN CHANNEL (UPDATED FOR PRIVATE CHANNELS)
    ----------------------------------------------------- */
    socket.on("chat:join", async (channelKey) => {
      if (!channelKey) return;

      try {
        const meta = getChannelMetaFromKey(channelKey);

        // Get or create channel
        const channel = await getOrCreateChannelByKey({
          key: channelKey,
          type: meta.type,
          name: meta.name,
          createdBy: userId,
        });

        const room = `channel:${channelKey}`;
        socket.join(room);

        const recent = await getRecentMessagesByChannelKey(channelKey, 100);

        socket.emit("chat:history", {
          channelId: channelKey,
          messages: recent.map((m) => ({
            id: m.id,
            channelId: channelKey,
            userId: m.user_id,
            username: m.username || username,
            encrypted: m.encrypted_json,
            senderPublicKeyJwk: m.sender_public_key,
            fallbackText: m.fallback_text,
            textHtml: m.text_html,
            createdAt: m.created_at,
            updatedAt: m.updated_at,
            deletedAt: m.deleted_at,
            reactions: m.reactions || {},
            attachments: m.attachments || [],
          })),
        });

        // Active huddle state sync
        const active = await getActiveHuddle(channelKey);
        if (active) {
          socket.emit("huddle:started", {
            channelId: channelKey,
            huddleId: active.huddle_id,
            startedBy: {
              userId: active.started_by,
              username: active.started_by ? "User" : "Unknown",
            },
            at: active.started_at,
            persisted: true,
          });
        }

        socket.to(room).emit("chat:system", {
          type: "join",
          channelId: channelKey,
          userId,
          username,
          at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("chat:join error:", err.message);
      }
    });

    /* -----------------------------------------------------
       CHAT: LEAVE
    ----------------------------------------------------- */
    socket.on("chat:leave", (channelKey) => {
      if (!channelKey) return;

      const room = `channel:${channelKey}`;
      socket.leave(room);

      io.to(room).emit("chat:system", {
        type: "leave",
        channelId: channelKey,
        userId,
        username,
        at: new Date().toISOString(),
      });
    });

    /* -----------------------------------------------------
       CHAT: MESSAGE
    ----------------------------------------------------- */
    socket.on("chat:message", async ({ channelId, text, tempId, parentId }) => {
      if (!channelId || !text?.trim()) return;

      try {
        const meta = getChannelMetaFromKey(channelId);

        const channel = await getOrCreateChannelByKey({
          key: channelId,
          type: meta.type,
          name: meta.name,
          createdBy: userId,
        });

        if (channel.isPrivate || channel.is_private) {
          const member = await isChannelMember(channel.id, userId).catch(
            () => false
          );
          if (!member) {
            return socket.emit("chat:error", {
              error: "You are not a member of this private channel.",
            });
          }
        }

        await ensureChannelMember(channel.id, userId);

        const encryptedJson = text.trim();

        const saved = await createChatMessage({
          channelId: channel.id,
          userId,
          textHtml: encryptedJson,
          encryptedJson,
          fallbackText: null,
          parentId: parentId || null,
        });

        io.to(`channel:${channelId}`).emit("chat:message", {
          id: saved.id,
          tempId: tempId || null,
          channelId,
          userId,
          username,
          textHtml: saved.text_html,
          createdAt: saved.created_at,
          updatedAt: saved.updated_at,
          deletedAt: saved.deleted_at,
          reactions: saved.reactions || {},
          attachments: saved.attachments || [],
        });
      } catch (err) {
        console.error("chat:message error:", err.message);
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

        io.to(`channel:${channelId}`).emit("chat:messageEdited", {
          id: updated.id,
          channelId,
          userId: updated.user_id,
          username,
          textHtml: updated.text_html,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        });
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

        io.to(`channel:${channelId}`).emit("chat:messageDeleted", {
          id: deleted.id,
          channelId,
          userId: deleted.user_id,
          username,
          deletedAt: deleted.deleted_at,
        });
      } catch (err) {
        console.error("chat:delete error:", err.message);
      }
    });

    /* -----------------------------------------------------
       REACTIONS / TYPING / READ
    ----------------------------------------------------- */
    socket.on("chat:reaction", (payload) =>
      io.to(`channel:${payload.channelId}`).emit("chat:reaction", {
        ...payload,
        userId,
        username,
        at: new Date().toISOString(),
      })
    );

    socket.on("chat:typing", ({ channelId }) =>
      socket.to(`channel:${channelId}`).emit("chat:typing", {
        channelId,
        userId,
        username,
        at: new Date().toISOString(),
      })
    );

    socket.on("chat:read", ({ channelId, at }) =>
      socket.to(`channel:${channelId}`).emit("chat:read", {
        channelId,
        userId,
        username,
        at: at || new Date().toISOString(),
      })
    );

    /* -----------------------------------------------------
       HUDDLES — PERSISTENT DB-BACKED
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

      io.to(`channel:${channelId}`).emit("huddle:started", {
        channelId,
        huddleId,
        startedBy: { userId, username },
        at: new Date().toISOString(),
        persisted: true,
      });
    });

    socket.on("huddle:end", async ({ channelId, huddleId }) => {
      if (!channelId || !huddleId) return;

      await endHuddle({ channelKey: channelId, huddleId });

      io.to(`channel:${channelId}`).emit("huddle:ended", {
        channelId,
        huddleId,
        endedBy: { userId, username },
        at: new Date().toISOString(),
      });
    });

    socket.on("huddle:join", ({ channelId, huddleId }) =>
      socket.to(`channel:${channelId}`).emit("huddle:user-joined", {
        channelId,
        huddleId,
        userId,
        username,
        at: new Date().toISOString(),
      })
    );

    socket.on("huddle:leave", ({ channelId, huddleId }) =>
      socket.to(`channel:${channelId}`).emit("huddle:user-left", {
        channelId,
        huddleId,
        userId,
        username,
        at: new Date().toISOString(),
      })
    );

    /* -----------------------------------------------------
       HUDDLE SIGNALING
    ----------------------------------------------------- */
    socket.on("huddle:signal", ({ channelId, targetUserId, huddleId, data }) => {
      if (!channelId || !targetUserId || !huddleId || !data) return;

      io.to(targetUserId).emit("huddle:signal", {
        channelId,
        huddleId,
        fromUserId: userId,
        toUserId: targetUserId,
        data,
      });
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
      });
    });

    /* -----------------------------------------------------
       DISCONNECT
    ----------------------------------------------------- */
    socket.on("disconnect", () => {
      console.log("Socket disconnected:", userId);
      io.emit("presence:update", {
        userId,
        username,
        status: "offline",
        at: new Date().toISOString(),
      });
    });
  });
}

/* -----------------------------------------------------
   EXPORT IO + helper emits
----------------------------------------------------- */
export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}

// convenience emit helpers other modules can use:
export function emitChannelCreated(channel) {
  if (!io) return;
  io.emit("chat:channel_created", channel);
}
export function emitMemberAdded(channelId, userId) {
  if (!io) return;
  io.to(userId).emit("chat:added_to_channel", { channelId });
  io.to(`channel:${channelId}`).emit("chat:member_added", { channelId, userId });
}
export function emitMessage(channelKey, message) {
  if (!io || !message) return;

  // IMPORTANT:
  // Frontend Chat.jsx uses "channelId" as the CHANNEL KEY
  // (e.g. "general", "availability-updates", "project-manager")
  // in messagesByChannel[...] and activeChannelKey.
  // So we ALWAYS send channelId = channelKey here,
  // even if the DB row has a numeric UUID in channel_id.
  const payload = {
    id: message.id || message.tempId || message.message_id || null,
    tempId: message.tempId || null,

    // 👇 this must match activeChannelKey on the frontend
    channelId: channelKey,

    userId: message.userId || message.user_id,
    username: message.username,

    textHtml:
      message.textHtml ||
      message.text_html ||
      message.text ||
      message.fallback_text ||
      "",

    createdAt: message.createdAt || message.created_at || new Date().toISOString(),
    updatedAt: message.updatedAt || message.updated_at || null,
    deletedAt: message.deletedAt || message.deleted_at || null,

    reactions: message.reactions || {},
    attachments: message.attachments || [],

    // pass through encrypted fields if present (for decryptForDisplay)
    encrypted: message.encrypted || message.encrypted_json,
    senderPublicKeyJwk:
      message.senderPublicKeyJwk || message.sender_public_key || null,
    fallbackText: message.fallbackText || message.fallback_text || "",
    parentId: message.parentId || message.parent_id || null,
  };

  io.to(`channel:${channelKey}`).emit("chat:message", payload);
}
