import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  getUserNotifications,
  markOneRead,
  markAllRead,
} from "../services/notification.service.js";

const router = express.Router();

/**
 * 🔐 AUTH REQUIRED
 * ⚠️ Workspace is OPTIONAL for notifications (Option A)
 */
router.use(authMiddleware);

/**
 * GET /notifications?unread=true|false
 * Returns notifications for:
 * - current user
 * - workspace-aware if available
 * - fallback-safe if workspace is missing
 */
router.get("/", async (req, res) => {
  try {
    const unreadOnly = req.query.unread === "true";

const workspaceId =
  req.workspaceId === "GLOBAL" ? null : req.workspaceId;

const notifications = await getUserNotifications(
  req.user.id,
  {
    unreadOnly,
    workspaceId, // UUID or null ONLY
  }
);


    res.json(notifications);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

/**
 * POST /notifications/:id/read
 * Mark ONE notification as read
 */
router.post("/:id/read", async (req, res) => {
  try {
    const updated = await markOneRead(
      req.params.id,
      req.user.id
    );

    if (!updated) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.json(updated);
  } catch (err) {
    console.error("Error marking notification read:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

/**
 * POST /notifications/mark-all-read
 * Mark ALL notifications read
 */
router.post("/mark-all-read", async (req, res) => {
  try {
    await markAllRead(req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Error marking all read:", err);
    res.status(500).json({ error: "Failed to update notifications" });
  }
});

export default router;
