// realtime/socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let io;
const JWT_SECRET = process.env.JWT_SECRET || "task_management_secret";

// 🔹 In-memory chat history per channel (persists while server is running)
const channelHistory = new Map(); // channelId -> [message, message, ...]

const MAX_HISTORY_PER_CHANNEL = 200;

function addMessageToHistory(channelId, message) {
  if (!channelId) return;
  const existing = channelHistory.get(channelId) || [];
  existing.push(message);
  // keep only last N
  if (existing.length > MAX_HISTORY_PER_CHANNEL) {
    existing.splice(0, existing.length - MAX_HISTORY_PER_CHANNEL);
  }
  channelHistory.set(channelId, existing);
}

function getHistory(channelId) {
  return channelId ? channelHistory.get(channelId) || [] : [];
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
      // payload should be: { id, username, email, role }
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

    // 🔔 Broadcast basic presence (you can later tie this to your attendance endpoints)
    io.emit("presence:update", {
      userId,
      username,
      status: "online",
      at: new Date().toISOString(),
    });

    // ─────────────────────────────
    // Chat channel helpers
    // ─────────────────────────────

    // Join a logical chat channel (e.g. "general")
    socket.on("chat:join", (channelId) => {
      if (!channelId) return;
      const room = `channel:${channelId}`;
      socket.join(room);

      // 1) Send existing history only to this socket
      const history = getHistory(channelId);
      socket.emit("chat:history", {
        channelId,
        messages: history,
      });

      // 2) Tell others user joined (system message)
      io.to(room).emit("chat:system", {
        type: "join",
        channelId,
        userId,
        username,
        at: new Date().toISOString(),
      });
    });

    // Leave a chat channel
    socket.on("chat:leave", (channelId) => {
      if (!channelId) return;
      const room = `channel:${channelId}`;
      socket.leave(room);
      io.to(room).emit("chat:system", {
        type: "leave",
        channelId,
        userId,
        username,
        at: new Date().toISOString(),
      });
    });

    // Incoming chat message (now also stored in history)
    // payload: { channelId, text, tempId? }
    socket.on("chat:message", (payload = {}) => {
      const { channelId, text, tempId } = payload;
      if (!channelId || !text || !text.trim()) return;

      const room = `channel:${channelId}`;

      const messageId =
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const message = {
        id: messageId,          // real server id
        tempId: tempId || null, // for optimistic UI reconciliation
        channelId,
        text: text.trim(),
        userId,
        username,
        createdAt: new Date().toISOString(),
      };

      // Store in in-memory history
      addMessageToHistory(channelId, message);

      // Broadcast to everyone in that channel
      io.to(room).emit("chat:message", message);
    });

    // Optional: presence update from client (e.g. online / aws / lunch / offline)
    socket.on("presence:set", (status) => {
      if (!status) return;
      io.emit("presence:update", {
        userId,
        username,
        status,
        at: new Date().toISOString(),
      });
    });

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
