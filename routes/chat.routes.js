// routes/chatChannels.routes.js
// ES module style to match your project (index.js uses import)
import express from "express";
import * as chatSvc from "../services/chat.service.js";
import { getIO } from "../realtime/socket.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

/* ✅ ADD: workspace + plan gating */
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";

const router = express.Router();

// reuse your existing auth middleware if present

/* -------------------------------------------------------
   ✅ FIX: define requireAuth (was missing)
   preserves existing behavior
------------------------------------------------------- */
function requireAuth(req, res, next) {
  if (req.user && req.user.id) return next();

  // fallback for legacy headers
  const uid = req.header("x-user-id") || req.get("x-user-id");
  if (!uid) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  req.user = { id: uid };
  next();
}

/* -------------------------------------------------------
   ✅ ADD: global enforcement (NO route logic touched)
------------------------------------------------------- */
router.use(authMiddleware);
router.use(requireAuth);
router.use(requireWorkspaceForUser);

/**
 * POST /chat/         -> create channel
 * body: { key, name, type, isPrivate (boolean), members: [userId...] }
 */
router.post("/", async (req, res) => {
  try {
    const {
      key,
      name,
      type = "channel",
      isPrivate = false,
      members = [],
    } = req.body;
    const createdBy = req.user.id;

    const channel = await chatSvc.createChannel({
      key,
      name,
      type,
      createdBy,
      isPrivate,
      /* ✅ ADD: workspace-safe */
      workspaceId: req.workspaceId,
    });

    // ensure creator added as admin/member
    try {
      await chatSvc.addChannelAdmin(channel.id, createdBy);
    } catch (e) {}
    try {
      await chatSvc.addChannelMember(channel.id, createdBy);
    } catch (e) {}

    if (Array.isArray(members) && members.length) {
      for (const m of members) {
        await chatSvc.addChannelMember(channel.id, m);
      }
    }

    try {
      const io = getIO();
      if (io) io.emit("chat:channel_created", channel);
    } catch (e) {
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
router.post("/:channelId/members", async (req, res) => {
  try {
    const { channelId } = req.params;
    const { userIdToAdd } = req.body;

    if (!userIdToAdd) {
      return res
        .status(400)
        .json({ message: "userIdToAdd required" });
    }

    const channel = chatSvc.getChannelByKey
      ? await chatSvc.getChannelByKey(channelId)
      : await chatSvc.getOrCreateChannelByKey({ key: channelId });

    let resolvedChannel = channel;

    if (!resolvedChannel && chatSvc.getChannelById) {
      resolvedChannel = await chatSvc.getChannelById(channelId);
    }

    const currentUserId = req.user.id;
    let allowed = false;

    if (!resolvedChannel) {
      allowed = true;
    } else {
      if (!resolvedChannel.isPrivate) allowed = true;
      if (
        resolvedChannel.createdBy === currentUserId ||
        resolvedChannel.created_by === currentUserId
      ) {
        allowed = true;
      }

      const isAdmin = await chatSvc
        .isChannelAdmin(resolvedChannel.id, currentUserId)
        .catch(() => false);

      const isMember = await chatSvc
        .isChannelMember(resolvedChannel.id, currentUserId)
        .catch(() => false);

      if (isAdmin || isMember) allowed = true;
    }

    if (!allowed) {
      return res.status(403).json({ message: "Not allowed to add members" });
    }

    await chatSvc.addChannelMember(
      resolvedChannel ? resolvedChannel.id : channelId,
      userIdToAdd
    );

    try {
      const io = getIO();
      if (io) {
        io.to(userIdToAdd).emit("chat:added_to_channel", {
          channelId: resolvedChannel ? resolvedChannel.id : channelId,
        });

        if (resolvedChannel) {
          io.to(`channel:${resolvedChannel.key || resolvedChannel.id}`).emit(
            "chat:member_added",
            { channelId: resolvedChannel.id, userId: userIdToAdd }
          );
        }
      }
    } catch (e) {}

    return res.json({
      channelId: resolvedChannel ? resolvedChannel.id : channelId,
      userId: userIdToAdd,
    });
  } catch (err) {
    console.error("POST /chat/:channelId/members error:", err);
    return res.status(500).json({ message: "Failed to add member" });
  }
});

/**
 * GET /chat/for-user -> list channels visible to user
 */
router.get("/for-user", async (req, res) => {
  try {
    const userId = req.user.id;
    const channels = await chatSvc.getChannelsForUserInWorkspace(userId, workspaceId)
;
    return res.json(channels);
  } catch (err) {
    console.error("GET /chat/for-user error:", err);
    return res.status(500).json({ message: "Failed to fetch channels" });
  }
});

export default router;
