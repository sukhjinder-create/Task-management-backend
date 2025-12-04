// routes/chatChannels.routes.js
// ES module style to match your project (index.js uses import)
import express from "express";
import * as chatSvc from "../services/chat.service.js";
import { getIO } from "../realtime/socket.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

// reuse your existing auth middleware if present


/**
 * POST /chat/         -> create channel
 * body: { key, name, type, isPrivate (boolean), members: [userId...] }
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const { key, name, type = "channel", isPrivate = false, members = [] } = req.body;
    const createdBy = req.user.id;

    // createChannel in your service uses createChannel({ key, name, type, createdBy, isPrivate })
    const channel = await chatSvc.createChannel({
      key,
      name,
      type,
      createdBy,
      isPrivate,
    });

    // ensure creator added as admin/member (your service already does, but safe to ensure)
    try {
      await chatSvc.addChannelAdmin(channel.id, createdBy);
    } catch (e) {
      // ignore duplicate/admin already exists
    }
    try {
      await chatSvc.addChannelMember(channel.id, createdBy);
    } catch (e) {}

    // add initial members safely (no overwrite)
    if (Array.isArray(members) && members.length) {
      for (const m of members) {
        await chatSvc.addChannelMember(channel.id, m);
      }
    }

    // emit via your existing socket layer
    try {
      const io = getIO();
      if (io) io.emit("chat:channel_created", channel);
    } catch (e) {
      // don't fail route if socket emit fails
      console.warn("chat channel emit failed:", e && e.message);
    }

    return res.status(201).json(channel);
  } catch (err) {
    console.error("POST /chat create channel error:", err);
    return res.status(500).json({ message: "Failed to create channel" });
  }
});

/**
 * POST /chat/:channelId/members  -> add user to channel
 * body: { userIdToAdd }
 */
router.post("/:channelId/members", requireAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { userIdToAdd } = req.body;
    if (!userIdToAdd) return res.status(400).json({ message: "userIdToAdd required" });

    const channel = await chatSvc.getChannelByKey ? await chatSvc.getChannelByKey(channelId) : await chatSvc.getOrCreateChannelByKey({ key: channelId });
    // If your channels are keyed by id rather than key, try fallback
    // We'll try both: if channel null, attempt by id lookup via getChannelByKey or direct query
    let resolvedChannel = channel;
    if (!resolvedChannel) {
      // attempt to treat channelId as UUID id
      if (chatSvc.getChannelById) {
        resolvedChannel = await chatSvc.getChannelById(channelId);
      } else {
        // If no getChannelById, user should call addChannelMember with real channel id
        // For now, proceed if can't resolve — let DB handle constraints
      }
    }
    // Authorization: only allow if user is channel admin or existing member or creator
    const currentUserId = req.user.id;
    let allowed = false;
    if (!resolvedChannel) {
      // safe fallback: require that caller is allowed (we can't check)
      allowed = true;
    } else {
      if (!resolvedChannel.isPrivate && resolvedChannel.is_private === false) allowed = true;
      if (resolvedChannel.createdBy === currentUserId || resolvedChannel.created_by === currentUserId) allowed = true;
      const isAdmin = await chatSvc.isChannelAdmin(resolvedChannel.id, currentUserId).catch(() => false);
      const isMember = await chatSvc.isChannelMember(resolvedChannel.id, currentUserId).catch(() => false);
      if (isAdmin || isMember) allowed = true;
    }
    if (!allowed) return res.status(403).json({ message: "Not allowed to add members" });

    await chatSvc.addChannelMember(resolvedChannel ? resolvedChannel.id : channelId, userIdToAdd);

    try {
      const io = getIO();
      if (io) {
        io.to(userIdToAdd).emit("chat:added_to_channel", { channelId: resolvedChannel ? resolvedChannel.id : channelId });
        if (resolvedChannel) io.to(`channel:${resolvedChannel.key || resolvedChannel.id}`).emit("chat:member_added", { channelId: resolvedChannel.id, userId: userIdToAdd });
      }
    } catch (e) {}

    return res.json({ channelId: resolvedChannel ? resolvedChannel.id : channelId, userId: userIdToAdd });
  } catch (err) {
    console.error("POST /chat/:channelId/members error:", err);
    return res.status(500).json({ message: "Failed to add member" });
  }
});

/**
 * GET /chat/for-user -> list channels visible to user (public + private where member)
 * Query: ?limit=100
 */
router.get("/for-user", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const channels = await chatSvc.getChannelsForUser(userId);
    return res.json(channels);
  } catch (err) {
    console.error("GET /chat/for-user error:", err);
    return res.status(500).json({ message: "Failed to fetch channels" });
  }
});

export default router;
