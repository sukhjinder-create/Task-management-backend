// routes/chatChannels.routes.js
// ES module style to match your project (index.js uses import)
import express from "express";
import * as chatSvc from "../services/chat.service.js";
import { getIO } from "../realtime/socket.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

/* -------------------------------------------------------
   ✅ ALL ROUTES BELOW REQUIRE REAL JWT AUTH
------------------------------------------------------- */
router.use(authMiddleware);

/* -------------------------------------------------------
   helper: normalize isPrivate / is_private
------------------------------------------------------- */
function getIsPrivateFromBody(body = {}) {
  if (typeof body.isPrivate === "boolean") return body.isPrivate;
  if (typeof body.is_private === "boolean") return body.is_private;
  return false;
}

/* -------------------------------------------------------
   helper: generate a safe unique key
------------------------------------------------------- */
function generateChannelKey(name = "") {
  const base =
    name
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "channel";
  const suffix = Math.random().toString(36).slice(2, 6);
  return `chan:${base}:${suffix}`;
}

/* -------------------------------------------------------
   CREATE CHANNEL
   Frontend:
   - CreateChannelModal → POST /chat
   (also supports POST /chat/channels for flexibility)
   Body: { name, is_private? or isPrivate?, members?: [userId] }
------------------------------------------------------- */

async function handleCreateChannel(req, res) {
  try {
    const { name = "", key, type = "channel", members = [] } = req.body;
    const isPrivate = getIsPrivateFromBody(req.body);
    const createdBy = req.user.id;

    if (!name.trim()) {
      return res.status(400).json({ error: "Channel name is required" });
    }

    const finalKey = key || generateChannelKey(name);

    const channel = await chatSvc.createChannel({
      key: finalKey,
      name: name.trim(),
      type,
      createdBy,
      isPrivate,
    });

    // Optionally add initial members (if provided)
    if (Array.isArray(members) && members.length) {
      for (const m of members) {
        if (!m) continue;
        await chatSvc.addChannelMember(channel.id, m);
      }
    }

    // Emit event to all sockets
    try {
      const io = getIO();
      if (io) io.emit("chat:channel_created", channel);
    } catch (e) {
      console.warn("chat channel emit failed:", e && e.message);
    }

    return res.status(201).json(channel);
  } catch (err) {
    console.error("POST /chat (create channel) error:", err);
    return res.status(500).json({ error: "Failed to create channel" });
  }
}

// Main endpoint used by our modal: POST /chat
router.post("/", handleCreateChannel);

// Also allow POST /chat/channels (for compatibility / future use)
router.post("/channels", handleCreateChannel);

/* -------------------------------------------------------
   MEMBERSHIP: ADD / REMOVE / LIST
   Frontend (ChannelSettingsModal) expects:
   - GET    /chat/channels/:id/members
   - POST   /chat/channels/:id/members   { user_id }
   - DELETE /chat/channels/:id/members/:userId
------------------------------------------------------- */

/**
 * GET /chat/channels/:channelId/members
 */
router.get("/channels/:channelId/members", async (req, res) => {
  try {
    const { channelId } = req.params;
    const members = await chatSvc.getChannelMembers(channelId);
    return res.json(members);
  } catch (err) {
    console.error("GET /chat/channels/:id/members error:", err);
    return res.status(500).json({ error: "Failed to fetch members" });
  }
});

/**
 * POST /chat/channels/:channelId/members
 * body: { user_id } or { userIdToAdd }
 */
router.post("/channels/:channelId/members", async (req, res) => {
  try {
    const { channelId } = req.params;
    const userIdToAdd =
      req.body.userIdToAdd || req.body.user_id || req.body.userId;

    if (!userIdToAdd) {
      return res.status(400).json({ error: "user_id required" });
    }

    const currentUserId = req.user.id;
    const channel = await chatSvc.getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    // Only admins OR channel creator can add members
    const isAdmin = await chatSvc
      .isChannelAdmin(channelId, currentUserId)
      .catch(() => false);

    if (
      !isAdmin &&
      String(channel.createdBy) !== String(currentUserId) &&
      String(channel.created_by) !== String(currentUserId)
    ) {
      return res
        .status(403)
        .json({ error: "Only channel admins can add members" });
    }

    await chatSvc.addChannelMember(channelId, userIdToAdd);

    try {
      const io = getIO();
      if (io) {
        io.to(userIdToAdd).emit("chat:added_to_channel", { channelId });
        io.to(`channel:${channel.key || channelId}`).emit("chat:member_added", {
          channelId,
          userId: userIdToAdd,
        });
      }
    } catch (e) {
      // ignore socket errors
    }

    return res.json({ channelId, userId: userIdToAdd });
  } catch (err) {
    console.error("POST /chat/channels/:id/members error:", err);
    return res.status(500).json({ error: "Failed to add member" });
  }
});

/**
 * DELETE /chat/channels/:channelId/members/:userId
 */
router.delete("/channels/:channelId/members/:userId", async (req, res) => {
  try {
    const { channelId, userId } = req.params;
    const currentUserId = req.user.id;

    const channel = await chatSvc.getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    const isAdmin = await chatSvc
      .isChannelAdmin(channelId, currentUserId)
      .catch(() => false);

    if (
      !isAdmin &&
      String(channel.createdBy) !== String(currentUserId) &&
      String(channel.created_by) !== String(currentUserId)
    ) {
      return res
        .status(403)
        .json({ error: "Only channel admins can remove members" });
    }

    await chatSvc.removeChannelMember(channelId, userId);
    await chatSvc.removeChannelAdmin(channelId, userId).catch(() => {});

    return res.json({ channelId, userId, removed: true });
  } catch (err) {
    console.error(
      "DELETE /chat/channels/:id/members/:userId error:",
      err
    );
    return res.status(500).json({ error: "Failed to remove member" });
  }
});

/* -------------------------------------------------------
   ADMINS: LIST / PROMOTE / DEMOTE
   Frontend expects:
   - GET    /chat/channels/:id/admins
   - POST   /chat/channels/:id/admins        { user_id }
   - DELETE /chat/channels/:id/admins/:userId
------------------------------------------------------- */

router.get("/channels/:channelId/admins", async (req, res) => {
  try {
    const { channelId } = req.params;
    const admins = await chatSvc.getChannelAdmins(channelId);
    return res.json(admins);
  } catch (err) {
    console.error("GET /chat/channels/:id/admins error:", err);
    return res.status(500).json({ error: "Failed to fetch admins" });
  }
});

router.post("/channels/:channelId/admins", async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.body.user_id || req.body.userId;

    if (!userId) {
      return res.status(400).json({ error: "user_id required" });
    }

    const currentUserId = req.user.id;

    const channel = await chatSvc.getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    const isAdmin = await chatSvc
      .isChannelAdmin(channelId, currentUserId)
      .catch(() => false);

    if (
      !isAdmin &&
      String(channel.createdBy) !== String(currentUserId) &&
      String(channel.created_by) !== String(currentUserId)
    ) {
      return res
        .status(403)
        .json({ error: "Only admins can promote other users" });
    }

    await chatSvc.addChannelAdmin(channelId, userId);
    return res.json({ channelId, userId });
  } catch (err) {
    console.error("POST /chat/channels/:id/admins error:", err);
    return res.status(500).json({ error: "Failed to promote admin" });
  }
});

router.delete("/channels/:channelId/admins/:userId", async (req, res) => {
  try {
    const { channelId, userId } = req.params;
    const currentUserId = req.user.id;

    const channel = await chatSvc.getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    const isAdmin = await chatSvc
      .isChannelAdmin(channelId, currentUserId)
      .catch(() => false);

    if (
      !isAdmin &&
      String(channel.createdBy) !== String(currentUserId) &&
      String(channel.created_by) !== String(currentUserId)
    ) {
      return res
        .status(403)
        .json({ error: "Only admins can remove admin rights" });
    }

    await chatSvc.removeChannelAdmin(channelId, userId);
    return res.json({ channelId, userId, removed: true });
  } catch (err) {
    console.error(
      "DELETE /chat/channels/:id/admins/:userId error:",
      err
    );
    return res.status(500).json({ error: "Failed to demote admin" });
  }
});

/* -------------------------------------------------------
   LEAVE & DELETE CHANNEL
   Frontend expects:
   - POST   /chat/channels/:id/leave
   - DELETE /chat/channels/:id
------------------------------------------------------- */

router.post("/channels/:channelId/leave", async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    await chatSvc.leaveChannel(channelId, userId);
    return res.json({ channelId, userId, left: true });
  } catch (err) {
    console.error("POST /chat/channels/:id/leave error:", err);
    return res.status(500).json({ error: "Failed to leave channel" });
  }
});

router.delete("/channels/:channelId", async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.id;

    await chatSvc.deleteChannel(channelId, userId);
    return res.json({ channelId, deleted: true });
  } catch (err) {
    console.error("DELETE /chat/channels/:id error:", err);
    if (err.message === "Only admins can delete the channel") {
      return res.status(403).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to delete channel" });
  }
});

/* -------------------------------------------------------
   CHANNEL LISTING (used by Chat.jsx)
   GET /chat/channels  -> channels visible to current user
------------------------------------------------------- */

router.get("/channels", async (req, res) => {
  try {
    const userId = req.user.id;
    const channels = await chatSvc.getChannelsForUser(userId);
    return res.json(channels);
  } catch (err) {
    console.error("GET /chat/channels error:", err);
    return res.status(500).json({ error: "Failed to fetch channels" });
  }
});

/* kept for compatibility: /chat/for-user */
router.get("/for-user", async (req, res) => {
  try {
    const userId = req.user.id;
    const channels = await chatSvc.getChannelsForUser(userId);
    return res.json(channels);
  } catch (err) {
    console.error("GET /chat/for-user error:", err);
    return res.status(500).json({ error: "Failed to fetch channels" });
  }
});

/* -------------------------------------------------------
   (Optional) Legacy: POST /chat/:channelKey/members by key
   — If you don't use this anywhere, you can delete it later.
------------------------------------------------------- */

router.post("/:channelKey/members", async (req, res) => {
  try {
    const { channelKey } = req.params;
    const userIdToAdd =
      req.body.userIdToAdd || req.body.user_id || req.body.userId;

    if (!userIdToAdd) {
      return res.status(400).json({ error: "user_id required" });
    }

    const channel =
      (chatSvc.getChannelByKey &&
        (await chatSvc.getChannelByKey(channelKey))) ||
      (await chatSvc.getOrCreateChannelByKey({
        key: channelKey,
        type: "channel",
        name: channelKey,
        createdBy: req.user.id,
      }));

    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    await chatSvc.addChannelMember(channel.id, userIdToAdd);

    return res.json({ channelId: channel.id, userId: userIdToAdd });
  } catch (err) {
    console.error("POST /chat/:channelKey/members error:", err);
    return res.status(500).json({ error: "Failed to add member" });
  }
});

export default router;
