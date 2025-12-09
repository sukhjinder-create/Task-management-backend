// routes/chatMessages.routes.js
import express from "express";
import {
  getChannelByKey,
  getChannelById,
  getOrCreateChannelByKey,
  isChannelMember,
  ensureChannelMember,
  createChatMessage,
  getRecentMessages,
} from "../services/chat.service.js";
import { getIO } from "../realtime/socket.js";

const router = express.Router();

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

/**
 * POST /chat
 * body: { channelId, text, tempId?, parentId? }
 * - channelId is treated as "key" (same as socket channels: "general", "dm:", etc.)
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const { channelId, encrypted, senderPublicKeyJwk, tempId = null, parentId = null, fallbackText = null } = req.body;

    const userId = req.user.id;

    if (!channelId || !encrypted) {

      return res.status(400).json({ message: "channelId and text are required" });
    }

    // Try resolve channel by key, then by id, then create by key if needed
    let channel = await getChannelByKey(channelId).catch(() => null);
    if (!channel) {
      channel = await getChannelById(channelId).catch(() => null);
    }
    if (!channel) {
      channel = await getOrCreateChannelByKey({
        key: channelId,
        type: "channel",
        name: channelId,
        createdBy: userId,
      });
    }

    // Private channel: only members or creator can post
    if (channel.isPrivate) {
      const member = await isChannelMember(channel.id, userId);
      if (!member && channel.createdBy !== userId && channel.created_by !== userId) {
        return res
          .status(403)
          .json({ message: "You are not allowed to post in this private channel" });
      }
    }

    // ensure membership
    await ensureChannelMember(channel.id, userId);

    const saved = await createChatMessage({
  channelId: channel.id,
  userId,
  encryptedJson: JSON.stringify(encrypted),
  senderPublicKeyJwk,
  fallbackText,
  parentId
});


    // emit via socket
    try {
      const io = getIO();
      io.to(`channel:${channel.key || channelId}`).emit("chat:message", {
        id: saved.id,
        tempId,
        channelId: channel.key || channelId,
        userId,
        username: saved.username || null,
        encrypted: encrypted,
senderPublicKeyJwk,
fallbackText,

        createdAt: saved.created_at,
        updatedAt: saved.updated_at,
        deletedAt: saved.deleted_at,
        parentId: saved.parent_id,
        reactions: saved.reactions || {},
        attachments: saved.attachments || [],
      });
    } catch (e) {
      console.warn("Failed to emit chat:message:", e.message);
    }

    return res.status(201).json(saved);
  } catch (err) {
    console.error("POST /chat message error:", err);
    return res.status(500).json({ message: "Failed to post message" });
  }
});

/**
 * GET /chat/for-channel/:channelId
 * channelId is treated as key first, then as id if not found
 */
router.get("/for-channel/:channelId", requireAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit || "100", 10);
    const userId = req.user.id;

    let channel = await getChannelByKey(channelId).catch(() => null);
    if (!channel) {
      channel = await getChannelById(channelId).catch(() => null);
    }
    if (!channel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    // Private channel: only members or creator can view
    if (channel.isPrivate) {
      const member = await isChannelMember(channel.id, userId);
      if (!member && channel.createdBy !== userId && channel.created_by !== userId) {
        return res
          .status(403)
          .json({ message: "You are not allowed to view this private channel" });
      }
    }

    const messages = await getRecentMessages(channel.id, limit);
    return res.json(messages);
  } catch (err) {
    console.error("GET /chat/for-channel error:", err);
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

export default router;
