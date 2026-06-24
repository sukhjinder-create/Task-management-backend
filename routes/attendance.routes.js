// routes/attendance.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  markSignIn,
  markSignOff,
  markAws,
  markLunch,
  markAvailableAfterAws,
  getLiveAttendanceDashboard,
} from "../services/attendance.service.js";
import { emitAttendanceUpdated } from "../realtime/socket.js";

const router = express.Router();

router.get("/live", authMiddleware, async (req, res) => {
  try {
    const data = await getLiveAttendanceDashboard({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(data);
  } catch (err) {
    console.error("Error loading live attendance:", err);
    res.status(500).json({ error: "Failed to load live attendance" });
  }
});

/**
 * POST /attendance/sign-in
 * Marks user as signed in (available) and sends Slack attendance message.
 */
router.post("/sign-in", authMiddleware, async (req, res) => {
  try {
    const changed = await markSignIn(req.user.id, req.workspaceId);
    if (changed) {
      emitAttendanceUpdated({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "sign_in",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error sign-in attendance:", err);
    res.status(500).json({ error: "Failed to send sign-in attendance" });
  }
});

/**
 * POST /attendance/sign-off
 * Marks user as signed off (no longer available) and sends Slack attendance message.
 */
router.post("/sign-off", authMiddleware, async (req, res) => {
  try {
    const changed = await markSignOff(req.user.id, req.workspaceId);
    if (changed) {
      emitAttendanceUpdated({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "sign_off",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error sign-off attendance:", err);
    res.status(500).json({ error: "Failed to send sign-off attendance" });
  }
});

/**
 * POST /attendance/aws
 * Body: { minutes: number }
 * Marks user as AWS for X minutes and sends Slack attendance message.
 */
router.post("/aws", authMiddleware, async (req, res) => {
  try {
    const { minutes } = req.body;
    const mins = Number(minutes);

    if (!mins || Number.isNaN(mins) || mins <= 0) {
      return res
        .status(400)
        .json({ error: "minutes must be a positive number" });
    }

    // Clamp to avoid crazy values (max 8 hours)
    const safeMinutes = Math.min(mins, 8 * 60);

    const changed = await markAws(req.user.id, safeMinutes, req.workspaceId);
    if (changed) {
      emitAttendanceUpdated({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "aws",
      });
    }
    res.json({ success: true, minutes: safeMinutes });
  } catch (err) {
    console.error("Error AWS attendance:", err);
    res.status(500).json({ error: "Failed to send AWS attendance" });
  }
});

/**
 * POST /attendance/lunch
 * Marks user as on lunch break and sends Slack attendance message (no duration).
 */
router.post("/lunch", authMiddleware, async (req, res) => {
  try {
    const changed = await markLunch(req.user.id, req.workspaceId);
    if (changed) {
      emitAttendanceUpdated({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "lunch",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error lunch attendance:", err);
    res.status(500).json({ error: "Failed to send lunch break attendance" });
  }
});

/**
 * POST /attendance/available
 * Marks user as available again after AWS or lunch.
 * - If AWS data exists → include early/later timing in Slack.
 * - If no AWS data (e.g. lunch) → generic "available again" message.
 */
router.post("/available", authMiddleware, async (req, res) => {
  try {
    const changed = await markAvailableAfterAws(req.user.id, req.workspaceId);
    if (changed) {
      emitAttendanceUpdated({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "available",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error available attendance:", err);
    res.status(500).json({ error: "Failed to update availability" });
  }
});

export default router;
