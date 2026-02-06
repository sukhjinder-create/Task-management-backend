import express from "express";
import pool from "../db.js";

const router = express.Router();

/**
 * GET /reports
 * Query params:
 *  - project (name)
 *  - from (date string)
 *  - to (date string)
 */
router.get("/reports", async (req, res) => {
  const { project, from, to } = req.query;
  const workspaceId = req.headers["x-workspace-id"];

  if (!workspaceId || !project || !from || !to) {
    return res.status(400).json({
      error: "Missing required parameters",
    });
  }

  try {
    // 1️⃣ Resolve project ID
    const projectRes = await pool.query(
      `
      SELECT id
      FROM projects
      WHERE workspace_id = $1
        AND LOWER(name) = LOWER($2)
      LIMIT 1
      `,
      [workspaceId, project]
    );

    if (!projectRes.rows.length) {
      return res.json([]);
    }

    const projectId = projectRes.rows[0].id;

    // 2️⃣ Fetch tasks in date range
    const tasksRes = await pool.query(
      `
      SELECT
        t.created_at::date AS date,
        t.status,
        t.assigned_to,
        COUNT(*)::int AS count
      FROM tasks t
      WHERE t.workspace_id = $1
        AND t.project_id = $2
        AND t.created_at::date BETWEEN $3 AND $4
      GROUP BY date, status, assigned_to
      ORDER BY date ASC
      `,
      [workspaceId, projectId, from, to]
    );

    res.json(tasksRes.rows);
  } catch (err) {
    console.error("❌ Reports query failed:", err);
    res.status(500).json({ error: "Failed to load reports" });
  }
});

router.get("/reports/export", async (req, res) => {
  const { project, from, to, format = "csv" } = req.query;
  const workspaceId = req.headers["x-workspace-id"];

  if (!workspaceId || !project || !from || !to) {
    return res.status(400).send("Missing parameters");
  }

  try {
    const result = await pool.query(
      `
      SELECT
        t.task,
        t.status,
        t.priority,
        t.created_at::date AS created_date
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.workspace_id = $1
        AND LOWER(p.name) = LOWER($2)
        AND t.created_at::date BETWEEN $3 AND $4
      ORDER BY t.created_at ASC
      `,
      [workspaceId, project, from, to]
    );

    if (format === "csv") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="report-${project}.csv"`
      );
      res.setHeader("Content-Type", "text/csv");

      res.write("Task,Status,Priority,Created Date\n");
      result.rows.forEach((r) => {
        res.write(
          `"${r.task}","${r.status}","${r.priority}","${r.created_date}"\n`
        );
      });
      res.end();
      return;
    }

    res.status(400).send("Unsupported format");
  } catch (err) {
    console.error("❌ Report export failed:", err);
    res.status(500).send("Export failed");
  }
});

export default router;
