// routes/chatMessages.routes.js
import express from "express";
import {
  getChannelByKey,
  getChannelById,
  isChannelMember,
  ensureChannelMember,
  createChatMessage,
  getRecentMessagesResolved,
  getRecentMessagesByChannelKey,
} from "../services/chat.service.js";
import { getIO } from "../realtime/socket.js";

import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { sendPushToUser } from "../services/push.service.js";
import pool from "../db.js";

const router = express.Router();

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
        /* ✅ ADD: workspace-safe */
        workspaceId: req.workspaceId,
      });
    }

    // Private channel: only members or creator can post
    if (channel.isPrivate) {
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
    await ensureChannelMember(channel.id, userId);

    // encrypted JSON envelope we persist
    const encryptedJson = encrypted;

    const saved = await createChatMessage({
      channelKey: channel.key || channelId,
      userId,
      tempId: tempId || null,
      textHtml: encryptedJson,
      encryptedJson,
      fallbackText: fallbackText || null,
      parentId: parentId || null,
      attachments: Array.isArray(attachments) ? attachments : [],
      workspaceId: req.workspaceId,
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
        encrypted,
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

    // Push notification to other channel members (non-blocking)
    try {
      const { rows: members } = await pool.query(
        "SELECT user_id FROM chat_channel_members WHERE channel_id = $1 AND user_id != $2",
        [channel.id, userId]
      );
      console.log(`[push:chat] channel=${channel.id} members=${members.length}`);
      const senderName = saved.username || "Someone";
      // Sanitize fallbackText — never send encrypted JSON as notification body
      const isEncrypted = (s) => typeof s === "string" && s.trim().startsWith("{");
      const safePreview = (!fallbackText || isEncrypted(fallbackText))
        ? "Sent a message"
        : (fallbackText.length > 80 ? fallbackText.slice(0, 77) + "…" : fallbackText);
      const isDMChannel = channel.is_dm || (channel.key || "").startsWith("dm:");
      const notifTitle = isDMChannel ? senderName : `${senderName} in #${channel.name || channel.key || "chat"}`;
      const chatUrl = `/chat`;
      for (const { user_id } of members) {
        console.log(`[push:chat] sending to user_id=${user_id}`);
        sendPushToUser({
          userId: user_id,
          title: notifTitle,
          body: safePreview,
          url: chatUrl,
          type: "chat",
        }).catch((e) => console.error("[push:chat] sendPushToUser error:", e.message));
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
      messages = await getRecentMessagesByChannelKey(keyForHistory, limit);
    } catch (e) {
      console.warn(
        "getRecentMessagesByChannelKey failed, falling back to getRecentMessagesResolved:",
        e.message
      );
      messages = await getRecentMessagesResolved(
        channel.id,
        limit,
        keyForHistory
      );
    }

    return res.json(messages);
  } catch (err) {
    console.error("GET /chat/for-channel error:", err);
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

export default router;

