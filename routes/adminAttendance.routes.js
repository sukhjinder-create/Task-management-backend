import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import pool from "../db.js";

const router = express.Router();

/**
 * =====================================================
 * 🔐 ADMIN ATTENDANCE REPORTS
 * - Auth required
 * - Workspace required
 * - Admin only
 * - READ ONLY
 * =====================================================
 */

router.use(authMiddleware);

// 🔐 Admin only
router.use((req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
});


/**
 * 🔹 GET /admin/attendance
 *
 * Optional query params:
 * - from (YYYY-MM-DD)
 * - to (YYYY-MM-DD)
 * - userId
 *
 * None are mandatory.
 */
router.get("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { from, to, userId } = req.query;

    const workspaceId =
  req.query.workspaceId || req.headers["x-workspace-id"];

if (!workspaceId) {
  return res.status(400).json({
    error: "workspaceId is required for admin reports",
  });
}

const conditions = [`workspace_id = $1`];
const values = [workspaceId];

    let idx = 2;

    if (from) {
      conditions.push(`date >= $${idx++}`);
      values.push(from);
    }

    if (to) {
      conditions.push(`date <= $${idx++}`);
      values.push(to);
    }

    if (userId) {
      conditions.push(`user_id = $${idx++}`);
      values.push(userId);
    }

    const query = `
      SELECT
        user_id,
        date,
        total_signed_in_minutes,
        aws_minutes,
        lunch_minutes,
        available_minutes,
        screen_on_minutes,
        screen_off_minutes
      FROM daily_attendance
      WHERE ${conditions.join(" AND ")}
      ORDER BY date DESC, user_id
      LIMIT 500
    `;

    const { rows } = await pool.query(query, values);

    res.json(rows);
  } catch (err) {
    console.error("Admin attendance report error:", err);
    res.status(500).json({ error: "Failed to load attendance reports" });
  }
});

export default router;
