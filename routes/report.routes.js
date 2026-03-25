// routes/report.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { requirePlanFeature } from "../middleware/plan.middleware.js";
import pool from "../db.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

// helper: parse date or null
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * GET /reports/combined
 */
router.get(
  "/combined",
  authMiddleware,
  requireWorkspaceForUser,
  requirePlanFeature("reports"),
  async (req, res) => {
    // Determine access scope: admin sees all, manager sees only their assigned projects
    let managerProjectIds = null; // null = no restriction (admin)
    if (req.user.role === "manager") {
      const { rows: mgRows } = await pool.query(
        `SELECT projects FROM users WHERE id = $1`,
        [req.user.id]
      );
      managerProjectIds = mgRows[0]?.projects || [];
    } else if (!["admin", "owner"].includes(req.user.role)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    try {
      const { projects, users, status, priority, sprints } = req.query;
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);

      const whereClauses = [`t.workspace_id = $1`];
      const values = [req.workspaceId];
      let idx = 2;

      if (managerProjectIds !== null) {
        // Manager: intersect requested projects with their assigned projects
        const requested = projects
          ? projects.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const effective = requested.length
          ? requested.filter((id) => managerProjectIds.includes(id))
          : managerProjectIds;
        if (effective.length > 0) {
          whereClauses.push(`t.project_id = ANY($${idx++})`);
          values.push(effective);
        } else {
          return res.json({
            summary: { total: 0, completed: 0, in_progress: 0, overdue: 0 },
            byStatus: [], byUser: [], byProject: [], bySprint: [], tasks: [],
          });
        }
      } else if (projects) {
        const projectIds = projects.split(",").map((s) => s.trim()).filter(Boolean);
        if (projectIds.length > 0) {
          whereClauses.push(`t.project_id = ANY($${idx++})`);
          values.push(projectIds);
        }
      }

      if (users) {
        const userIds = users.split(",").map((s) => s.trim()).filter(Boolean);
        if (userIds.length > 0) {
          whereClauses.push(`t.assigned_to = ANY($${idx++})`);
          values.push(userIds);
        }
      }

      if (sprints) {
        const sprintIds = sprints.split(",").map((s) => s.trim()).filter(Boolean);
        if (sprintIds.length > 0) {
          whereClauses.push(`t.sprint_id = ANY($${idx++})`);
          values.push(sprintIds);
        }
      }

      if (from) {
        whereClauses.push(`t.created_at::date >= $${idx++}`);
        values.push(from);
      }
      if (to) {
        whereClauses.push(`t.created_at::date <= $${idx++}`);
        values.push(to);
      }

      if (status) {
        whereClauses.push(`t.status = $${idx++}`);
        values.push(status);
      }

      if (priority) {
        whereClauses.push(`t.priority = $${idx++}`);
        values.push(priority);
      }

      const whereSql = `WHERE ${whereClauses.join(" AND ")}`;

      const byStatusRes = await pool.query(
        `SELECT t.status, COUNT(*)::int AS count
         FROM tasks t
         ${whereSql}
         GROUP BY t.status
         ORDER BY t.status`,
        values
      );

      const byUserRes = await pool.query(
        `SELECT u.id, u.username, u.email,
                COUNT(t.*)::int AS task_count
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assigned_to
         ${whereSql}
         GROUP BY u.id, u.username, u.email
         ORDER BY task_count DESC NULLS LAST`,
        values
      );

      const byProjectRes = await pool.query(
        `SELECT p.id, p.name,
                COUNT(t.*)::int AS task_count
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         ${whereSql}
         GROUP BY p.id, p.name
         ORDER BY task_count DESC NULLS LAST`,
        values
      );

      const bySprintRes = await pool.query(
        `SELECT s.id, s.name, s.status AS sprint_status,
                COUNT(t.*)::int AS task_count,
                COUNT(t.*) FILTER (WHERE t.status = 'completed')::int AS completed_count
         FROM tasks t
         LEFT JOIN sprints s ON s.id = t.sprint_id
         ${whereSql}
         GROUP BY s.id, s.name, s.status
         ORDER BY task_count DESC NULLS LAST`,
        values
      );

      const summaryRes = await pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed,
           COUNT(*) FILTER (WHERE t.status = 'in-progress')::int AS in_progress,
           COUNT(*) FILTER (
             WHERE t.status != 'completed'
               AND t.due_date IS NOT NULL
               AND t.due_date::date < NOW()::date
           )::int AS overdue
         FROM tasks t
         ${whereSql}`,
        values
      );

      const tasksRes = await pool.query(
        `SELECT
           t.*,
           p.name AS project_name,
           p.project_code,
           u.username,
           u.email,
           s.name AS sprint_name,
           CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
                THEN p.project_code || '-' || t.ticket_number
                ELSE NULL
           END AS display_id
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u    ON u.id = t.assigned_to
         LEFT JOIN sprints s  ON s.id = t.sprint_id
         ${whereSql}
         ORDER BY
           CASE WHEN t.status != 'completed' AND t.due_date IS NOT NULL AND t.due_date::date < NOW()::date THEN 0 ELSE 1 END,
           t.due_date ASC NULLS LAST,
           t.created_at DESC`,
        values
      );

      logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "report.download", entityType: "reports", metadata: { reportType: "combined", from: req.query.from, to: req.query.to } });

      res.json({
        summary: summaryRes.rows[0] || { total: 0, completed: 0, in_progress: 0, overdue: 0 },
        byStatus: byStatusRes.rows,
        byUser: byUserRes.rows,
        byProject: byProjectRes.rows,
        bySprint: bySprintRes.rows,
        tasks: tasksRes.rows,
      });
    } catch (err) {
      console.error("Error generating combined report:", err);
      res.status(500).json({ error: "Failed to generate report" });
    }
  }
);

/**
 * GET /reports/project/:projectId
 */
router.get(
  "/project/:projectId",
  authMiddleware,
  requireWorkspaceForUser,
  requirePlanFeature("reports"),
  async (req, res) => {
    // Users cannot access project reports
    if (req.user.role === "user") {
      return res.status(403).json({ error: "Not allowed" });
    }
    // Managers can only access reports for their assigned projects
    if (req.user.role === "manager") {
      const { rows } = await pool.query(
        `SELECT projects FROM users WHERE id = $1`,
        [req.user.id]
      );
      const assignedProjects = rows[0]?.projects || [];
      if (!assignedProjects.includes(req.params.projectId)) {
        return res.status(403).json({ error: "Not assigned to this project" });
      }
    }
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

      logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "report.download", entityType: "reports", entityId: projectId, metadata: { reportType: "project", projectId, from: req.query.from, to: req.query.to } });

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
  }
);

/**
 * GET /reports/user/:userId
 */
router.get(
  "/user/:userId",
  authMiddleware,
  requireWorkspaceForUser,
  requirePlanFeature("reports"),
  async (req, res) => {
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

      logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "report.download", entityType: "reports", entityId: userId, metadata: { reportType: "user", targetUserId: userId, from: req.query.from, to: req.query.to } });

      res.json({
        summary: summaryRes.rows[0],
        byProject: byProjectRes.rows,
        tasks: tasksRes.rows,
      });
    } catch (err) {
      console.error("Error generating user report:", err);
      res.status(500).json({ error: "Failed to generate report" });
    }
  }
);

export default router;
