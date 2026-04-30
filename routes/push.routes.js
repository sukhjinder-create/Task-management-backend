// routes/push.routes.js
import express from "express";
import pool from "../db.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  registerPushToken,
  unregisterPushToken,
  getPreferences,
  updatePreferences,
  sendPushToUser,
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

// Diagnostic endpoint — logs push registration steps from the native app
router.post("/diag", authMiddleware, async (req, res) => {
  const { msg, ts } = req.body || {};
  console.log(`[push:diag] user=${req.user?.id?.slice(0,8)} ${msg} (client_ts=${ts})`);
  res.json({ ok: true });
});

// Status — shows registered tokens for the current user (for debugging)
router.get("/status", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT platform, LEFT(endpoint,60) AS endpoint_preview, LEFT(fcm_token,30) AS fcm_preview, updated_at FROM user_push_tokens WHERE user_id::text = $1 ORDER BY updated_at DESC",
      [String(req.user.id)]
    );
    res.json({ userId: req.user.id, tokens: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test — send a test notification to the current user
router.post("/test", authMiddleware, async (req, res) => {
  try {
    await sendPushToUser({
      userId: req.user.id,
      title: "Test notification",
      body: "Push is working!",
      url: "/chat",
      type: "general",
    });
    res.json({ ok: true, userId: req.user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
