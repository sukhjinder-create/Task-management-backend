// realtime/socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import {
  getOrCreateChannelByKey,
  ensureChannelMember,
  createChatMessage,
  getRecentMessages,
  updateChatMessage,
  softDeleteChatMessage,
} from "../services/chat.service.js";

let io;
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";

/**
 * For DM channels we use key pattern:
 *   dm:<uidSmall>:<uidBig>
 */
function getChannelMetaFromKey(channelKey, currentUserId) {
  if (channelKey === "general") {
    return {
      type: "public",
      name: "#general",
    };
  }

  if (channelKey.startsWith("dm:")) {
    return {
      type: "dm",
      name: "Direct message",
    };
  }

  if (channelKey.startsWith("thread:")) {
    return {
      type: "thread",
      name: "Thread",
    };
  }

  return {
    type: "public",
    name: channelKey,
  };
}

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "http://localhost:5173",
      credentials: true,
    },
  });

  // Auth middleware for socket
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Unauthorized: no token"));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      // payload: { id, username, email, role }
      socket.user = payload;
      next();
    } catch (err) {
      console.error("Socket auth error", err.message);
      next(new Error("Unauthorized: invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;

    // Personal room for notifications
    socket.join(userId);
    console.log("Socket connected for user:", userId);

    // Basic presence broadcast (connected = online)
    io.emit("presence:update", {
      userId,
      username,
      status: "online",
      at: new Date().toISOString(),
    });

    // ─────────────────────────────
    // Chat: join a channel
    // ─────────────────────────────
    socket.on("chat:join", async (channelKey) => {
      if (!channelKey) return;

      try {
        const { type, name } = getChannelMetaFromKey(channelKey, userId);

        // 1) Resolve or create the channel in DB
        const channel = await getOrCreateChannelByKey({
          key: channelKey,
          type,
          name,
          createdBy: userId,
        });

        // 2) Ensure this user is listed as a member
        await ensureChannelMember(channel.id, userId);

        // 3) Join Socket.IO room
        const room = `channel:${channelKey}`;
        socket.join(room);

        // 4) Load last N messages
        const recent = await getRecentMessages(channel.id, 100);
        const history = recent.map((m) => ({
          id: m.id,
          channelId: channelKey,
          userId: m.user_id,
          username: m.username || username,
          textHtml: m.text_html,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
          deletedAt: m.deleted_at,
          reactions: m.reactions || {},
          attachments: m.attachments || [],
        }));

        socket.emit("chat:history", {
          channelId: channelKey,
          messages: history,
        });

        // 5) System message to others only
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

    // ─────────────────────────────
    // Chat: leave a channel
    // ─────────────────────────────
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

    // ─────────────────────────────
    // Chat: send a message
    // ─────────────────────────────
    // payload: { channelId, text, tempId?, parentId? }
    socket.on("chat:message", async (payload = {}) => {
      const { channelId: channelKey, text, tempId, parentId } = payload;
      if (!channelKey || !text || !text.trim()) return;

      try {
        const { type, name } = getChannelMetaFromKey(channelKey, userId);

        // Resolve channel (id) again by key
        const channel = await getOrCreateChannelByKey({
          key: channelKey,
          type,
          name,
          createdBy: userId,
        });

        // Ensure membership
        await ensureChannelMember(channel.id, userId);

        const textHtml = text.trim();

        // Save in DB
        const saved = await createChatMessage({
          channelId: channel.id,
          userId,
          textHtml,
          parentId: parentId || null,
        });

        const message = {
          id: saved.id,
          tempId: tempId || null,
          channelId: channelKey,
          userId,
          username,
          textHtml: saved.text_html,
          createdAt: saved.created_at,
          updatedAt: saved.updated_at,
          deletedAt: saved.deleted_at,
          reactions: saved.reactions || {},
          attachments: saved.attachments || [],
        };

        const room = `channel:${channelKey}`;
        io.to(room).emit("chat:message", message);
      } catch (err) {
        console.error("chat:message error:", err.message);
      }
    });

    // ─────────────────────────────
    // Chat: edit a message (persistent)
    // ─────────────────────────────
    // payload: { channelId, messageId, text }
    socket.on("chat:edit", async (payload = {}) => {
      const { channelId: channelKey, messageId, text } = payload;
      if (!channelKey || !messageId || !text || !text.trim()) return;

      try {
        const textHtml = text.trim();

        const updated = await updateChatMessage({
          messageId,
          userId,
          textHtml,
        });

        if (!updated) return;

        const room = `channel:${channelKey}`;
        io.to(room).emit("chat:messageEdited", {
          id: updated.id,
          channelId: channelKey,
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

    // ─────────────────────────────
    // Chat: delete a message (soft delete)
    // ─────────────────────────────
    // payload: { channelId, messageId }
    socket.on("chat:delete", async (payload = {}) => {
      const { channelId: channelKey, messageId } = payload;
      if (!channelKey || !messageId) return;

      try {
        const deleted = await softDeleteChatMessage({
          messageId,
          userId,
        });

        if (!deleted) return;

        const room = `channel:${channelKey}`;
        io.to(room).emit("chat:messageDeleted", {
          id: deleted.id,
          channelId: channelKey,
          userId: deleted.user_id,
          username,
          deletedAt: deleted.deleted_at,
        });
      } catch (err) {
        console.error("chat:delete error:", err.message);
      }
    });

    // ─────────────────────────────
    // Typing indicator
    // ─────────────────────────────
    // payload: { channelId }
    socket.on("chat:typing", (payload = {}) => {
      const { channelId } = payload;
      if (!channelId) return;
      const room = `channel:${channelId}`;
      socket.to(room).emit("chat:typing", {
        channelId,
        userId,
        username,
        at: new Date().toISOString(),
      });
    });

    // ─────────────────────────────
    // Read receipts
    // ─────────────────────────────
    // payload: { channelId, at? }
    socket.on("chat:read", (payload = {}) => {
      const { channelId, at } = payload;
      if (!channelId) return;
      const room = `channel:${channelId}`;
      const ts = at || new Date().toISOString();
      socket.to(room).emit("chat:read", {
        channelId,
        userId,
        username,
        at: ts,
      });
    });

    // ─────────────────────────────
    // Reactions (ephemeral, broadcast only)
    // ─────────────────────────────
    // payload: { channelId, messageId, emoji, action: "add" | "remove" }
    socket.on("chat:reaction", (payload = {}) => {
      const { channelId, messageId, emoji, action } = payload;
      if (!channelId || !messageId || !emoji || !action) return;
      const room = `channel:${channelId}`;
      io.to(room).emit("chat:reaction", {
        channelId,
        messageId,
        emoji,
        action,
        userId,
        username,
        at: new Date().toISOString(),
      });
    });

    // ─────────────────────────────
    // Huddles (start/end events)
    // ─────────────────────────────
    // payload: { channelId, huddleId }
    socket.on("huddle:start", (payload = {}) => {
      const { channelId, huddleId } = payload;
      if (!channelId || !huddleId) return;
      const room = `channel:${channelId}`;
      io.to(room).emit("huddle:started", {
        channelId,
        huddleId,
        startedBy: { userId, username },
        at: new Date().toISOString(),
      });
    });

    socket.on("huddle:end", (payload = {}) => {
      const { channelId, huddleId } = payload;
      if (!channelId || !huddleId) return;
      const room = `channel:${channelId}`;
      io.to(room).emit("huddle:ended", {
        channelId,
        huddleId,
        endedBy: { userId, username },
        at: new Date().toISOString(),
      });
    });

    // ─────────────────────────────
    // Huddle WebRTC signaling relay
    // ─────────────────────────────
    // payload: { channelId, huddleId, data: { type, sdp?, candidate? } }
    socket.on("huddle:signal", (payload = {}) => {
      const { channelId, huddleId, data } = payload;
      if (!channelId || !huddleId || !data) return;
      const room = `channel:${channelId}`;

      // Relay to everyone else in that channel
      socket.to(room).emit("huddle:signal", {
        channelId,
        huddleId,
        data,
        fromUserId: userId,
        fromUsername: username,
        at: new Date().toISOString(),
      });
    });

    // ─────────────────────────────
    // Presence update from client
    // ─────────────────────────────
    socket.on("presence:set", (status) => {
      if (!status) return;
      io.emit("presence:update", {
        userId,
        username,
        status,
        at: new Date().toISOString(),
      });
    });

    // ─────────────────────────────
    // Disconnect
    // ─────────────────────────────
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

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
