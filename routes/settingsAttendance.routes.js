// routes/settingsAttendance.routes.js
import express from "express";

const router = express.Router();

/**
 * GET /settings/attendance
 * Frontend uses this to initialize attendance-related state
 */
router.get("/attendance", async (req, res) => {
  try {
    const workspaceId = req.workspaceId;

    // Minimal, stable response — extend later if needed
    return res.json({
      enabled: true,
      workspaceId,
      tracking: {
        signIn: true,
        signOff: true,
        breaks: true,
      },
    });
  } catch (err) {
    console.error("Failed to load attendance settings:", err);
    res.status(500).json({ error: "Failed to load attendance settings" });
  }
});

export default router;
