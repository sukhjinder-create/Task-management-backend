// routes/chatMessages.routes.js
import express from "express";
import {
  getChannelByKey,
  getChannelById,
  isChannelMember,
  ensureChannelMember,
  createChannel,
  createChatMessage,
  getRecentMessagesResolved,
  getRecentMessagesByChannelKey,
  markChannelRead,
  getUnreadCounts,
} from "../services/chat.service.js";
import { getIO } from "../realtime/socket.js";

import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { sendPushToUsers } from "../services/push.service.js";
import pool from "../db.js";

const router = express.Router();

function extractMessagePreview(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") && trimmed.includes("fallbackText")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.fallbackText === "string") return parsed.fallbackText.trim();
      } catch {}
    }
    return trimmed;
  }
  if (typeof value === "object") {
    if (typeof value.fallbackText === "string") return value.fallbackText.trim();
    if (typeof value.message === "string") return value.message.trim();
    if (typeof value.text === "string") return value.text.trim();
  }
  return "";
}

/* -------------------------------------------------------
   EXISTING AUTH (PRESERVED EXACTLY)
------------------------------------------------------- */
function requireAuth(req, res, next) {
  if (req.user && req.user.id) return next();

  const uid = req.header("x-user-id") || req.get("x-user-id");
  if (!uid) {
    return res
      .status(401)
      .json({ message: "Unauthorized: missing user (x-user-id header)" });
  }
  req.user = { id: uid };
  next();
}

/* -------------------------------------------------------
   ✅ ADD: workspace + plan enforcement
   (NO logic change to routes below)
------------------------------------------------------- */
router.use(requireAuth);
router.use(requireWorkspaceForUser);

/**
 * POST /chat
 * body: { channelId, encrypted, senderPublicKeyJwk, tempId?, parentId?, fallbackText? }
 * - channelId is treated as "key" (same as socket channels: "general", "dm:", etc.)
 */
router.post("/", async (req, res) => {
  try {
    const {
      channelId,
      encrypted,
      senderPublicKeyJwk,
      tempId = null,
      parentId = null,
      fallbackText = null,
      attachments = [],
    } = req.body;

    const userId = req.user.id;

    if (!channelId || !encrypted) {
      return res
        .status(400)
        .json({ message: "channelId and encrypted are required" });
    }

    const isDMChannel = channelId.startsWith("dm:");
    if (isDMChannel) {
      const participants = channelId.split(":").slice(1).filter(Boolean);
      if (!participants.includes(String(userId))) {
        return res.status(403).json({ message: "You are not allowed to post in this DM" });
      }
    }

    // Try resolve channel by key, then by id, then create by key if needed
    let channel = await getChannelByKey(channelId, req.workspaceId).catch(() => null);
    if (!channel) {
      channel = await getChannelById(channelId).catch(() => null);
    }
    if (channel && String(channel.workspaceId) !== String(req.workspaceId)) {
      channel = null;
    }
    if (!channel && !isDMChannel) {
      channel = await createChannel({
        key: channelId,
        type: "channel",
        name: channelId,
        createdBy: userId,
        /* ✅ ADD: workspace-safe */
        workspaceId: req.workspaceId,
      });
    }

    // Private channel: only members or creator can post
    if (channel?.isPrivate) {
      const member = await isChannelMember(channel.id, userId);
      if (
        !member &&
        channel.createdBy !== userId &&
        channel.created_by !== userId
      ) {
        return res.status(403).json({
          message: "You are not allowed to post in this private channel",
        });
      }
    }

    // ensure membership
    if (channel) {
      await ensureChannelMember(channel.id, userId);
    }

    // encrypted JSON envelope we persist
    const encryptedJson = encrypted;
    const plainFallback = extractMessagePreview(fallbackText) || extractMessagePreview(encryptedJson);

    const saved = await createChatMessage({
      channelKey: channel?.key || channelId,
      userId,
      tempId: tempId || null,
      textHtml: plainFallback,
      encryptedJson,
      fallbackText: plainFallback || null,
      parentId: parentId || null,
      attachments: Array.isArray(attachments) ? attachments : [],
      workspaceId: req.workspaceId,
    });

    // emit via socket
    try {
      const io = getIO();
      const channelKey = channel?.key || channelId;
      const msgPayload = {
        id: saved.id,
        tempId,
        channelId: channelKey,
        userId,
        username: saved.username || null,
        textHtml: saved.text_html || plainFallback || "",
        encrypted: encryptedJson,
        senderPublicKeyJwk,
        fallbackText: plainFallback,
        createdAt: saved.created_at,
        updatedAt: saved.updated_at,
        deletedAt: saved.deleted_at,
        parentId: saved.parent_id,
        reactions: saved.reactions || {},
        attachments: saved.attachments || [],
      };
      const isDMChannel = channelKey.startsWith("dm:");
      const isPrivateChannel = channel?.is_private;

      if (isDMChannel) {
        // DM: unread-bump each other participant. The saved message is emitted
        // once by createChatMessage/emitMessage.
        const parts = channelKey.split(":");
        for (let i = 1; i < parts.length; i++) {
          const uid = parts[i];
          if (uid && uid !== String(userId)) {
            io.to(uid).emit("chat:unread-bump", { channelKey });
          }
        }
      } else if (!isPrivateChannel) {
        // Public channel: workspace-wide broadcast so ALL connected users see the badge
        io.to(`workspace:${req.workspaceId}`).emit("chat:unread-bump", {
          channelKey,
          fromUserId: String(userId),
        });
      } else {
        // Private channel: only explicit members
        const { rows: privMembers } = await pool.query(
          "SELECT user_id FROM chat_channel_members WHERE channel_id = $1 AND user_id != $2",
          [channel.id, userId]
        );
        for (const { user_id } of privMembers) {
          io.to(user_id).emit("chat:unread-bump", { channelKey });
        }
      }
    } catch (e) {
      console.warn("Failed to emit chat:message:", e.message);
    }

    // Push notification to other channel members (non-blocking)
    try {
      const channelKey = channel?.key || channelId;
      const messageIsDMChannel = channelKey.startsWith("dm:");
      const members = messageIsDMChannel
        ? channelKey
            .split(":")
            .slice(1)
            .filter((uid) => uid && uid !== String(userId))
            .map((uid) => ({ user_id: uid }))
        : (await pool.query(
            "SELECT user_id FROM chat_channel_members WHERE channel_id = $1 AND user_id != $2",
            [channel.id, userId]
          )).rows;
      console.log(`[push:chat] channel=${channelKey} members=${members.length}`);
      const senderName = saved.username || "Someone";
      // Sanitize fallbackText — never send encrypted JSON as notification body
      const isEncrypted = (s) => typeof s === "string" && s.trim().startsWith("{");
      const safePreview = (!plainFallback || isEncrypted(plainFallback))
        ? "Sent a message"
        : (plainFallback.length > 80 ? plainFallback.slice(0, 77) + "…" : plainFallback);
      const notifTitle = messageIsDMChannel ? senderName : `${senderName} in #${channel?.name || channelKey || "chat"}`;
      const chatUrl = `/chat?channel=${encodeURIComponent(channelKey)}`;
      // Members with an active connection already got the unread-bump/room broadcast
      // above, so skip them here — push only genuinely offline recipients. Batches
      // preference + token lookups and sends FCM via multicast instead of one HTTP
      // call per member, so fan-out cost no longer scales with channel size.
      const offlineMembers = members
        .map((m) => m.user_id)
        .filter((uid) => !io.sockets.adapter.rooms.has(String(uid)));
      console.log(`[push:chat] channel=${channelKey} offline recipients=${offlineMembers.length}/${members.length}`);
      if (offlineMembers.length) {
        sendPushToUsers(offlineMembers, {
          title: notifTitle,
          body: safePreview,
          url: chatUrl,
          type: "chat",
        }).catch((e) => console.error("[push:chat] sendPushToUsers error:", e.message));
      }
    } catch (e) {
      console.error("[push:chat] member query error:", e.message);
    }

    return res.status(201).json(saved);
  } catch (err) {
    console.error("POST /chat message error:", err);
    return res.status(500).json({ message: "Failed to post message" });
  }
});

/**
 * GET /chat/for-channel/:channelId
 *
 * channelId is treated as key first, then as id if not found.
 * We prefer history by canonical key, with a safe fallback to the
 * generic getRecentMessages (supports legacy rows).
 */
router.get("/for-channel/:channelId", async (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit || "100", 10);
    const userId = req.user.id;

    let channel = await getChannelByKey(channelId, req.workspaceId).catch(() => null);
    if (!channel) {
      channel = await getChannelById(channelId).catch(() => null);
    }
    if (channel && String(channel.workspaceId) !== String(req.workspaceId)) {
      channel = null;
    }
    if (!channel) {
      if (channelId.startsWith("dm:")) {
        const participants = channelId.split(":").slice(1).filter(Boolean);
        if (!participants.includes(String(userId))) {
          return res.status(403).json({ message: "You are not allowed to view this DM" });
        }
        const messages = await getRecentMessagesResolved(channelId, limit, req.workspaceId);
        return res.json(messages);
      }
      return res.status(404).json({ message: "Channel not found" });
    }

    // Private channel: only members or creator can view
    if (channel.isPrivate) {
      const member = await isChannelMember(channel.id, userId);
      if (
        !member &&
        channel.createdBy !== userId &&
        channel.created_by !== userId
      ) {
        return res.status(403).json({
          message: "You are not allowed to view this private channel",
        });
      }
    }

    const keyForHistory = channel.key || channelId;

    let messages;
    try {
      // Preferred: by channel key
      messages = await getRecentMessagesByChannelKey(keyForHistory, limit, req.workspaceId);
    } catch (e) {
      console.warn(
        "getRecentMessagesByChannelKey failed, falling back to getRecentMessagesResolved:",
        e.message
      );
      messages = await getRecentMessagesResolved(
        keyForHistory,
        limit,
        req.workspaceId
      );
    }

    return res.json(messages);
  } catch (err) {
    console.error("GET /chat/for-channel error:", err);
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// GET /chat/unread-counts — returns { channelKey: count } for unread messages
router.get("/unread-counts", async (req, res) => {
  try {
    const counts = await getUnreadCounts(req.user.id, req.workspaceId);
    res.json(counts);
  } catch (err) {
    console.error("[unread] getUnreadCounts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /chat/mark-read — mark a channel as fully read
router.post("/mark-read", async (req, res) => {
  try {
    const { channelKey } = req.body;
    if (!channelKey) return res.status(400).json({ error: "channelKey required" });
    await markChannelRead(req.user.id, channelKey);
    res.json({ ok: true });
  } catch (err) {
    console.error("[unread] markChannelRead error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

