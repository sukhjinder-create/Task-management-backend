import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import pool from "../db.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

/**
 * GET /admin/attendance/export
 * Query:
 *  - month (YYYY-MM)
 */
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

router.get("/export", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { month } = req.query;
    if (!month) {
      return res.status(400).json({ error: "Month is required (YYYY-MM)" });
    }

    const monthDate = `${month}-01`;

    const query = `
      SELECT
        u.username,
        m.month,
        m.signed_in_minutes,
        m.available_minutes,
        m.aws_minutes,
        m.lunch_minutes,
        m.screen_on_minutes,
        m.screen_off_minutes
      FROM attendance_monthly m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
        AND m.month = $2
      ORDER BY u.username
    `;

    const { rows } = await pool.query(query, [
      req.workspaceId,
      monthDate,
    ]);

    // CSV HEADER
    let csv =
      "Username,Month,Total Hours,Available Hours,AWS Hours,Lunch Hours,Screen ON Hours,Screen OFF Hours\n";

    for (const r of rows) {
      csv += [
        r.username,
        month,
        (r.signed_in_minutes / 60).toFixed(2),
        (r.available_minutes / 60).toFixed(2),
        (r.aws_minutes / 60).toFixed(2),
        (r.lunch_minutes / 60).toFixed(2),
        (r.screen_on_minutes / 60).toFixed(2),
        (r.screen_off_minutes / 60).toFixed(2),
      ].join(",") + "\n";
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=attendance_${month}.csv`
    );

    logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "attendance.export", entityType: "reports", metadata: { month } });

    res.send(csv);
  } catch (err) {
    console.error("CSV export failed:", err);
    res.status(500).json({ error: "CSV export failed" });
  }
});

export default router;
