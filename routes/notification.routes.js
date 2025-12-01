// routes/notification.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  getUserNotifications,
  markOneRead,
  markAllRead,
} from "../services/notification.service.js";

const router = express.Router();

// GET /notifications?unread=true|false
router.get("/", authMiddleware, async (req, res) => {
  try {
    const unreadOnly = req.query.unread === "true";
    const notifications = await getUserNotifications(req.user.id, {
      unreadOnly,
    });
    res.json(notifications);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// POST /notifications/:id/read
router.post("/:id/read", authMiddleware, async (req, res) => {
  try {
    const updated = await markOneRead(req.params.id, req.user.id);
    if (!updated) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json(updated);
  } catch (err) {
    console.error("Error marking notification read:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// POST /notifications/mark-all-read
router.post("/mark-all-read", authMiddleware, async (req, res) => {
  try {
    await markAllRead(req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Error marking all read:", err);
    res.status(500).json({ error: "Failed to update notifications" });
  }
});

export default router;
