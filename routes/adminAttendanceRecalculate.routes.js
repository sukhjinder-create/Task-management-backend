import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { recalculateDailyAttendance } from "../services/attendanceRecalculate.service.js";

const router = express.Router();

router.use(authMiddleware);
router.use(requireWorkspaceForUser);

/**
 * POST /admin/attendance/recalculate
 */
router.post("/recalculate", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }

    const { from, to, userId } = req.body;

    const result = await recalculateDailyAttendance({
      workspaceId: req.workspaceId,
      from,
      to,
      userId,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("Attendance recalculation failed:", err);
    res.status(500).json({ error: "Recalculation failed" });
  }
});

export default router;
