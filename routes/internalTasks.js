import express from "express";
import pool from "../db.js";
import { requireInternalServiceSecret } from "../config/secrets.js";

const router = express.Router();

router.post("/internal/tasks/create-from-ai", requireInternalServiceSecret, async (req, res) => {
  const { workspaceId, userId, task } = req.body || {};

  // 🛑 BASIC VALIDATION
  if (!workspaceId || !userId || !task) {
    return res.status(400).json({
      error: "missing_required_fields",
      message: "workspaceId, userId and task are required",
    });
  }

  const { title, projectName, description, assignedTo } = task;

  if (!title || title.trim().length < 3) {
    return res.status(400).json({
      error: "invalid_title",
      message: "Task title is missing or too short",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /**
     * 🔍 RESOLVE PROJECT (MANDATORY)
     */
    let projectId = null;

    if (projectName) {
      const projectRes = await client.query(
        `
        SELECT id
        FROM projects
        WHERE workspace_id = $1
          AND LOWER(name) = LOWER($2)
        LIMIT 1
        `,
        [workspaceId, projectName]
      );

      if (!projectRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "invalid_project",
          message: `Project "${projectName}" not found`,
        });
      }

      projectId = projectRes.rows[0].id;
    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "missing_project",
        message: "Project name is required",
      });
    }

    /**
     * 👤 VALIDATE ASSIGNEE (OPTIONAL)
     */
    let finalAssignee = null;

    if (assignedTo) {
      const userRes = await client.query(
        `
        SELECT id
        FROM users
        WHERE id = $1
        `,
        [assignedTo]
      );

      if (!userRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "invalid_assignee",
          message: "Assignee not found in this workspace",
        });
      }

      finalAssignee = assignedTo;
    }

    /**
     * 📝 CREATE TASK
     */
    const insertRes = await client.query(
      `
      INSERT INTO tasks (
        id,
        workspace_id,
        project_id,
        task,
        description,
        assigned_to,
        added_by,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, NOW()
      )
      RETURNING *
      `,
      [
        workspaceId,
        projectId,
        title.trim(),
        description || null,
        finalAssignee,
        userId,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      task: insertRes.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("❌ AI task creation failed:", err);

    return res.status(500).json({
      error: "task_creation_failed",
      message: "Unexpected error while creating task",
    });
  } finally {
    client.release();
  }
});

export default router;
