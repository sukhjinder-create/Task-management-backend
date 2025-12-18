// src/realtime/socket.js
// Workspace-aware Socket.IO server that preserves legacy behavior.
// Backwards compatible: keeps legacy room names and emits, while also
// adding optional workspace-scoped rooms for newer clients.

import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import {
  getOrCreateChannelByKey,
  ensureChannelMember,
  createChatMessage,
  updateChatMessage,
  softDeleteChatMessage,
  isChannelMember,
  getRecentMessagesByChannelKey,
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

  /* -----------------------------------------------------
     CONNECTION  ✅ SINGLE, VALID
  ----------------------------------------------------- */
  io.on("connection", (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;

    socket.workspaceId =
      socket.user.workspaceId === WORKSPACE_GLOBAL
        ? null
        : socket.user.workspaceId;

    (async () => {
      try {
        if (!socket.workspaceId && workspaceService?.getMembershipByUserId) {
          const membership =
            await workspaceService.getMembershipByUserId(String(userId));
          if (membership?.workspace_id) {
            socket.workspaceId = membership.workspace_id;
          }
        }
      } catch (err) {
        console.error(
          "Failed to load workspace membership for socket:",
          err.message
        );
      }
    })();

    socket.join(userId);

    console.log(
      "Socket connected for user:",
      userId,
      "workspace:",
      socket.workspaceId || WORKSPACE_GLOBAL
    );

    io.emit("presence:update", {
      userId,
      username,
      status: "online",
      at: new Date().toISOString(),
      workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
    });

   /* -----------------------------------------------------
   CHAT: JOIN CHANNEL
----------------------------------------------------- */
socket.on("chat:join", async (channelKey) => {
  if (!channelKey) return;

  try {
    const meta = getChannelMetaFromKey(channelKey);
    const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

    const channel = await getOrCreateChannelByKey({
      key: channelKey,
      type: meta.type,
      name: meta.name,
      createdBy: userId,
      workspaceId: socket.workspaceId ?? null,
    });

    const legacyRoom = legacyRoomName(channelKey);
    const wsRoom = workspaceRoomName(channelKey, workspaceId);

    socket.join(legacyRoom);
    socket.join(wsRoom);

    const resolvedWorkspaceId =
  workspaceId && workspaceId !== WORKSPACE_GLOBAL
    ? workspaceId
    : null;

    let recent = [];

    const channelRow = await getChannelByKey(
      channelKey,
      resolvedWorkspaceId
    );

    if (!channelRow) {
      socket.emit("chat:history", {
        channelId: channelKey,
        messages: [],
      });
      return;
    }

    recent = await getRecentMessagesByChannelKey(
      channelKey,
      100,
      resolvedWorkspaceId
    );

    socket.emit("chat:history", {
      channelId: channelKey,
      workspaceId: resolvedWorkspaceId,
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
        workspaceId: m.workspace_id ?? resolvedWorkspaceId,
      })),
    });

    const active = await getActiveHuddle(channelKey);
    if (active) {
      socket.emit("huddle:started", {
        channelId: channelKey,
        workspaceId:
          channel.workspaceId ||
          (workspaceId === WORKSPACE_GLOBAL
            ? WORKSPACE_GLOBAL
            : workspaceId),
        huddleId: active.huddle_id,
        startedBy: {
          userId: active.started_by,
          username: active.started_by ? "User" : "Unknown",
        },
        at: active.started_at,
        persisted: true,
      });
    }

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
  } catch (err) {
    console.error("chat:join error:", err.message);
  }
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

      io.to(legacyRoom).emit("chat:system", {
        type: "leave",
        channelId: channelKey,
        workspaceId,
        userId,
        username,
        at: new Date().toISOString(),
      });

      io.to(wsRoom).emit("chat:system", {
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
      if (!channelId || !text?.trim()) return;

      try {
        const meta = getChannelMetaFromKey(channelId);
        const workspaceId = socket.workspaceId || WORKSPACE_GLOBAL;

        const channel = await getOrCreateChannelByKey({
          key: channelId,
          type: meta.type,
          name: meta.name,
          createdBy: userId,
          workspaceId: socket.workspaceId ?? null,
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
          workspaceId:
            channel.workspaceId ||
            (workspaceId === WORKSPACE_GLOBAL ? null : workspaceId),
        });

        const payload = {
          id: saved.id,
          tempId: tempId || null,
          channelId,
          workspaceId:
            saved.workspace_id ||
            channel.workspaceId ||
            (workspaceId === WORKSPACE_GLOBAL
              ? WORKSPACE_GLOBAL
              : workspaceId),
          userId,
          username,
          textHtml: saved.text_html,
          createdAt: saved.created_at,
          updatedAt: saved.updated_at,
          deletedAt: saved.deleted_at,
          reactions: saved.reactions || {},
          attachments: saved.attachments || [],
        };

        io.to(legacyRoomName(channelId)).emit("chat:message", payload);
        io.to(
          workspaceRoomName(channelId, payload.workspaceId || WORKSPACE_GLOBAL)
        ).emit("chat:message", payload);
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
       DISCONNECT
    ----------------------------------------------------- */
    socket.on("disconnect", () => {
      console.log("Socket disconnected:", userId);
      io.emit("presence:update", {
        userId,
        username,
        status: "offline",
        at: new Date().toISOString(),
        workspaceId: socket.workspaceId || WORKSPACE_GLOBAL,
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
  if (!io || !message) return;

  const payload = {
    id: message.id || message.tempId || message.message_id || null,
    tempId: message.tempId || null,
    channelId: channelKey,
    workspaceId: message.workspaceId || message.workspace_id || workspaceId,
    userId: message.userId || message.user_id,
    username: message.username,
    textHtml:
      message.textHtml ||
      message.text_html ||
      message.text ||
      message.fallback_text ||
      "",
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

  io.to(legacyRoomName(channelKey)).emit("chat:message", payload);
  io.to(
    workspaceRoomName(channelKey, payload.workspaceId || workspaceId)
  ).emit("chat:message", payload);
}
