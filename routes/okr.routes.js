// routes/okr.routes.js
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

// ─── OBJECTIVES ───────────────────────────────────────────────────────────────

router.get("/objectives", async (req, res) => {
  try {
    const { timePeriod, ownerId } = req.query;
    const conditions = ["o.workspace_id = $1"];
    const params = [req.workspaceId];
    let i = 2;

    if (timePeriod) { conditions.push(`o.time_period = $${i++}`); params.push(timePeriod); }
    if (ownerId)    { conditions.push(`o.owner_id = $${i++}`);    params.push(ownerId); }

    const rows = await db.query(
      `SELECT o.*, u.username AS owner_name,
              (SELECT json_agg(kr ORDER BY kr.created_at)
               FROM okr_key_results kr WHERE kr.objective_id = o.id) AS key_results
       FROM okr_objectives o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY o.created_at DESC`,
      params
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/objectives", async (req, res) => {
  try {
    const { title, description, time_period, owner_id, parent_id } = req.body;
    if (!title || !time_period) return res.status(400).json({ error: "title and time_period are required" });

    const row = await db.query(
      `INSERT INTO okr_objectives (workspace_id, owner_id, title, description, time_period, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, owner_id || req.user.id, title, description || null, time_period, parent_id || null]
    );
    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "okr.objective.create", entityType: "okr_objective", entityId: row.rows[0].id, newValue: { title } });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/objectives/:id", async (req, res) => {
  try {
    const { title, description, time_period, status, progress, owner_id } = req.body;
    const row = await db.query(
      `UPDATE okr_objectives SET
         title       = COALESCE($1, title),
         description = COALESCE($2, description),
         time_period = COALESCE($3, time_period),
         status      = COALESCE($4, status),
         progress    = COALESCE($5, progress),
         owner_id    = COALESCE($6, owner_id),
         updated_at  = NOW()
       WHERE id = $7 AND workspace_id = $8 RETURNING *`,
      [title, description, time_period, status, progress, owner_id, req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/objectives/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM okr_objectives WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── KEY RESULTS ──────────────────────────────────────────────────────────────

router.post("/objectives/:objectiveId/key-results", async (req, res) => {
  try {
    const { title, type = "number", start_value = 0, target_value, current_value = 0, unit, due_date, owner_id } = req.body;
    if (!title || target_value === undefined) return res.status(400).json({ error: "title and target_value are required" });

    const row = await db.query(
      `INSERT INTO okr_key_results
         (objective_id, title, owner_id, type, start_value, target_value, current_value, unit, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.objectiveId, title, owner_id || req.user.id, type, start_value, target_value, current_value, unit || null, due_date || null]
    );
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/key-results/:id", async (req, res) => {
  try {
    const { title, current_value, status, due_date } = req.body;
    const row = await db.query(
      `UPDATE okr_key_results SET
         title         = COALESCE($1, title),
         current_value = COALESCE($2, current_value),
         status        = COALESCE($3, status),
         due_date      = COALESCE($4, due_date),
         updated_at    = NOW()
       WHERE id = $5 RETURNING *`,
      [title, current_value, status, due_date, req.params.id]
    );

    // Auto-recalculate parent objective progress
    if (row.rows[0]) {
      const kr = row.rows[0];
      const allKRs = await db.query(
        "SELECT * FROM okr_key_results WHERE objective_id = $1",
        [kr.objective_id]
      );
      const krs = allKRs.rows;
      const totalProgress = krs.reduce((acc, k) => {
        const range = Number(k.target_value) - Number(k.start_value);
        if (range <= 0) return acc;
        const pct = Math.min(100, ((Number(k.current_value) - Number(k.start_value)) / range) * 100);
        return acc + pct;
      }, 0);
      const avgProgress = krs.length > 0 ? totalProgress / krs.length : 0;

      await db.query(
        "UPDATE okr_objectives SET progress = $1, updated_at = NOW() WHERE id = $2",
        [Math.round(avgProgress * 100) / 100, kr.objective_id]
      );
    }

    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/key-results/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM okr_key_results WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
