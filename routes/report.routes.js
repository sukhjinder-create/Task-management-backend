// routes/report.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import pool from "../db.js";

const router = express.Router();

// helper: parse date or null
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * NEW: GET /reports/combined
 * Query params (all optional):
 * - projects: comma-separated project IDs
 * - users: comma-separated user IDs (assigned_to)
 * - from: YYYY-MM-DD
 * - to: YYYY-MM-DD
 * - status: pending | in-progress | completed
 * - priority: high | medium | low
 *
 * Returns:
 * {
 *   summary: { total, completed, overdue },
 *   byStatus: [{ status, count }],
 *   byUser:   [{ id, username, email, task_count }],
 *   byProject:[{ id, name, task_count }],
 *   tasks:    [ ... rows with project_name, username, email ... ]
 * }
 */
router.get("/combined", authMiddleware, async (req, res) => {
  try {
    const { projects, users, status, priority } = req.query;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    const whereClauses = [];
    const values = [];
    let idx = 1;

    // multi-project filter
    if (projects) {
      const projectIds = projects.split(",").map((s) => s.trim()).filter(Boolean);
      if (projectIds.length > 0) {
        whereClauses.push(`t.project_id = ANY($${idx++})`);
        values.push(projectIds);
      }
    }

    // multi-user filter (assigned_to)
    if (users) {
      const userIds = users.split(",").map((s) => s.trim()).filter(Boolean);
      if (userIds.length > 0) {
        whereClauses.push(`t.assigned_to = ANY($${idx++})`);
        values.push(userIds);
      }
    }

    // date range on created_at
    if (from) {
      whereClauses.push(`t.created_at::date >= $${idx++}`);
      values.push(from);
    }
    if (to) {
      whereClauses.push(`t.created_at::date <= $${idx++}`);
      values.push(to);
    }

    // status
    if (status) {
      whereClauses.push(`t.status = $${idx++}`);
      values.push(status);
    }

    // priority
    if (priority) {
      whereClauses.push(`t.priority = $${idx++}`);
      values.push(priority);
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // By status
    const byStatusRes = await pool.query(
      `
      SELECT t.status, COUNT(*)::int AS count
      FROM tasks t
      ${whereSql}
      GROUP BY t.status
      ORDER BY t.status
      `,
      values
    );

    // By user (assignee)
    const byUserRes = await pool.query(
      `
      SELECT u.id,
             u.username,
             u.email,
             COUNT(t.*)::int AS task_count
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      ${whereSql}
      GROUP BY u.id, u.username, u.email
      ORDER BY task_count DESC NULLS LAST
      `,
      values
    );

    // By project
    const byProjectRes = await pool.query(
      `
      SELECT p.id,
             p.name,
             COUNT(t.*)::int AS task_count
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      ${whereSql}
      GROUP BY p.id, p.name
      ORDER BY task_count DESC NULLS LAST
      `,
      values
    );

    // Summary
    const summaryRes = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (
          WHERE status != 'completed'
            AND due_date IS NOT NULL
            AND due_date::date < NOW()::date
        )::int AS overdue
      FROM tasks t
      ${whereSql}
      `,
      values
    );

    // Raw tasks (with project + user info) for table
    const tasksRes = await pool.query(
      `
      SELECT
        t.*,
        p.name  AS project_name,
        u.username,
        u.email
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN users u    ON u.id = t.assigned_to
      ${whereSql}
      ORDER BY t.created_at DESC
      `,
      values
    );

    res.json({
      summary: summaryRes.rows[0] || { total: 0, completed: 0, overdue: 0 },
      byStatus: byStatusRes.rows,
      byUser: byUserRes.rows,
      byProject: byProjectRes.rows,
      tasks: tasksRes.rows,
    });
  } catch (err) {
    console.error("Error generating combined report:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

/**
 * Existing endpoints you already had
 * (kept as-is, in case you still use them anywhere)
 */

// GET /reports/project/:projectId
router.get("/project/:projectId", authMiddleware, async (req, res) => {
  try {
    const { projectId } = req.params;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    const values = [projectId];
    let idx = 2;
    let dateFilter = "";

    if (from) {
      dateFilter += ` AND t.created_at::date >= $${idx++}`;
      values.push(from);
    }
    if (to) {
      dateFilter += ` AND t.created_at::date <= $${idx++}`;
      values.push(to);
    }

    const byStatusRes = await pool.query(
      `
      SELECT status, COUNT(*)::int AS count
      FROM tasks t
      WHERE t.project_id = $1
        ${dateFilter}
      GROUP BY status
      ORDER BY status
      `,
      values
    );

    const byUserRes = await pool.query(
      `
      SELECT u.id, u.username, u.email,
             COUNT(t.*)::int AS task_count
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.project_id = $1
        ${dateFilter}
      GROUP BY u.id, u.username, u.email
      ORDER BY task_count DESC NULLS LAST
      `,
      values
    );

    const summaryRes = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (
          WHERE status != 'completed'
            AND due_date IS NOT NULL
            AND due_date::date < NOW()::date
        )::int AS overdue
      FROM tasks t
      WHERE t.project_id = $1
        ${dateFilter}
      `,
      values
    );

    const tasksRes = await pool.query(
      `
      SELECT *
      FROM tasks t
      WHERE t.project_id = $1
        ${dateFilter}
      ORDER BY created_at DESC
      `,
      values
    );

    res.json({
      summary: summaryRes.rows[0],
      byStatus: byStatusRes.rows,
      byUser: byUserRes.rows,
      tasks: tasksRes.rows,
    });
  } catch (err) {
    console.error("Error generating project report:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// GET /reports/user/:userId
router.get("/user/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    if (req.user.role === "user" && req.user.id !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const values = [userId];
    let idx = 2;
    let dateFilter = "";

    if (from) {
      dateFilter += ` AND t.created_at::date >= $${idx++}`;
      values.push(from);
    }
    if (to) {
      dateFilter += ` AND t.created_at::date <= $${idx++}`;
      values.push(to);
    }

    const summaryRes = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (
          WHERE status != 'completed'
            AND due_date IS NOT NULL
            AND due_date::date < NOW()::date
        )::int AS overdue
      FROM tasks t
      WHERE t.assigned_to = $1
        ${dateFilter}
      `,
      values
    );

    const byProjectRes = await pool.query(
      `
      SELECT p.id, p.name,
             COUNT(t.*)::int AS task_count
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = $1
        ${dateFilter}
      GROUP BY p.id, p.name
      ORDER BY task_count DESC NULLS LAST
      `,
      values
    );

    const tasksRes = await pool.query(
      `
      SELECT t.*, p.name AS project_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = $1
        ${dateFilter}
      ORDER BY t.created_at DESC
      `,
      values
    );

    res.json({
      summary: summaryRes.rows[0],
      byProject: byProjectRes.rows,
      tasks: tasksRes.rows,
    });
  } catch (err) {
    console.error("Error generating user report:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

export default router;
