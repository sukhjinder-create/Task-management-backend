import express from "express";
import pool from "../db.js";

const router = express.Router();

/**
 * Latest integration events
 */
router.get("/events", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT event_type, entity_type, entity_id, created_at
    FROM workspace_events
    WHERE workspace_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [req.workspaceId]);

  res.json(rows);
});

/**
 * Integration state snapshot
 */
router.get("/state", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT *
    FROM integration_state
    WHERE workspace_id = $1
  `, [req.workspaceId]);

  res.json(rows);
});

export default router;
