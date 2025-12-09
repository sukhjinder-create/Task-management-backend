// routes/projectStatus.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import pool from "../db.js";

const router = express.Router();

// Only admin/manager can manage statuses
function canManage(user) {
  return user.role === "admin" || user.role === "manager";
}

// 🔹 NEW: GET /project-statuses/global -> all unique statuses across projects
router.get("/global", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT key AS status_key, label
       FROM project_statuses
       ORDER BY label`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error loading global statuses:", err);
    res.status(500).json({ error: "Failed to load global statuses" });
  }
});

// GET /project-statuses/:projectId  -> list statuses for board
router.get("/:projectId", authMiddleware, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM project_statuses
       WHERE project_id = $1
       ORDER BY sort_order ASC`,
      [projectId]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error loading project statuses:", err);
    res.status(500).json({ error: "Failed to load statuses" });
  }
});

// POST /project-statuses/:projectId  -> add new column (tab)
router.post("/:projectId", authMiddleware, async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { projectId } = req.params;
    const { key, label } = req.body;

    if (!key || !label) {
      return res.status(400).json({ error: "key and label are required" });
    }

    // limit 15 per project
    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS c FROM project_statuses WHERE project_id = $1",
      [projectId]
    );
    if (countRes.rows[0].c >= 15) {
      return res
        .status(400)
        .json({ error: "Maximum 15 status columns per project" });
    }

    const lastRes = await pool.query(
      "SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM project_statuses WHERE project_id = $1",
      [projectId]
    );
    const sort_order = lastRes.rows[0].max_order + 1;

    const insertRes = await pool.query(
      `INSERT INTO project_statuses (project_id, key, label, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [projectId, key, label, sort_order]
    );
    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    console.error("Error creating status:", err);
    res.status(400).json({ error: err.message });
  }
});

// PUT /project-statuses/:id  -> rename / reorder / default
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { id } = req.params;
    const { label, sort_order, is_default } = req.body;

    // simple partial update
    const { rows } = await pool.query(
      `UPDATE project_statuses
       SET
         label = COALESCE($1, label),
         sort_order = COALESCE($2, sort_order),
         is_default = COALESCE($3, is_default),
         updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [label ?? null, sort_order ?? null, is_default ?? null, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Status not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error updating status:", err);
    res.status(400).json({ error: err.message });
  }
});

// DELETE /project-statuses/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { id } = req.params;

    // don't allow delete if tasks still use it
    const taskRes = await pool.query(
      `SELECT 1
       FROM tasks
       WHERE status = (
         SELECT key FROM project_statuses WHERE id = $1
       )
       LIMIT 1`,
      [id]
    );
    if (taskRes.rows.length > 0) {
      return res
        .status(400)
        .json({ error: "Cannot delete a column that has tasks" });
    }

    await pool.query("DELETE FROM project_statuses WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting status:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
