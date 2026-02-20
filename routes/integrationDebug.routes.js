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
    ORDER BY created_at DESC
    LIMIT 50
  `);

  res.json(rows);
});

/**
 * Integration state snapshot
 */
router.get("/state", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT *
    FROM integration_state
  `);

  res.json(rows);
});

export default router;
