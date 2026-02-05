import express from "express";
import pool from "../db.js";

const router = express.Router();

router.post("/internal/tasks/create-from-ai", async (req, res) => {
  const auth = req.headers.authorization?.replace("Bearer ", "");

  if (auth !== process.env.AI_SERVICE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    workspaceId,
    userId,
    channelKey,
    task,
  } = req.body;

  if (!workspaceId || !userId || !task) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const {
    title,
    projectName,
    description,
    assignedTo, // ✅ FINAL assignee from AI
  } = task;

  if (!title) {
    return res.status(400).json({ error: "Task title missing" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /**
     * 🔍 Resolve project (optional)
     */
    let projectId = null;

    if (projectName) {
      const projectRes = await client.query(
        `
        SELECT id FROM projects
        WHERE workspace_id = $1 AND name ILIKE $2
        LIMIT 1
        `,
        [workspaceId, projectName]
      );

      if (projectRes.rows.length) {
        projectId = projectRes.rows[0].id;
      }
    }

    /**
     * 📝 Create task (ASSIGNEE COMES DIRECTLY FROM AI)
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
        $1, $2, $3, $4, $5, $6, now()
      )
      RETURNING *
      `,
      [
        workspaceId,
        projectId,
        title,                 // ✅ FIXED
        description || null,
        assignedTo || null,    // ✅ FIXED
        userId,
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      task: insertRes.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ AI task creation failed:", err);

    res.status(500).json({
      error: "Task creation failed",
    });
  } finally {
    client.release();
  }
});

export default router;
