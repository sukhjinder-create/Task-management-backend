// routes/push.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  registerPushToken,
  unregisterPushToken,
  getPreferences,
  updatePreferences,
  VAPID_PUBLIC_KEY,
} from "../services/push.service.js";

const router = express.Router();

// Return the VAPID public key so the frontend can subscribe
router.get("/vapid-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: "Push notifications not configured" });
  }
  res.json({ key: VAPID_PUBLIC_KEY });
});

// Register a push subscription / FCM token
router.post("/subscribe", authMiddleware, async (req, res) => {
  try {
    const { platform = "web", endpoint, p256dh, auth, fcmToken } = req.body;
    await registerPushToken({
      userId: req.user.id,
      workspaceId: req.user.workspaceId,
      platform,
      endpoint,
      p256dh,
      auth,
      fcmToken,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[push] subscribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Unregister a push subscription / FCM token (on logout)
router.post("/unsubscribe", authMiddleware, async (req, res) => {
  try {
    const { endpoint, fcmToken } = req.body;
    await unregisterPushToken({ userId: req.user.id, endpoint, fcmToken });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get notification preferences
router.get("/preferences", authMiddleware, async (req, res) => {
  try {
    const prefs = await getPreferences(req.user.id);
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update notification preferences
router.patch("/preferences", authMiddleware, async (req, res) => {
  try {
    const { mute_all, mute_tasks, mute_chat } = req.body;
    const prefs = await updatePreferences(req.user.id, { mute_all, mute_tasks, mute_chat });
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
