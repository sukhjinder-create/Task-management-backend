// routes/holidays.routes.js
// Holiday calendar + work schedule management.
// All routes require authentication + workspace membership (applied in index.js).
// Admin-only write operations are gated inside each handler.

import express from "express";
import db from "../db.js";

const router = express.Router();

// ─── Helper: run the migration idempotently ───────────────────────────────────
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_work_schedule (
      id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid        NOT NULL,
      work_days    integer[]   NOT NULL DEFAULT ARRAY[1,2,3,4,5],
      created_at   timestamptz DEFAULT now(),
      updated_at   timestamptz DEFAULT now(),
      UNIQUE(workspace_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS workspace_holidays (
      id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid         NOT NULL,
      date         date         NOT NULL,
      name         varchar(200) NOT NULL,
      created_by   uuid,
      created_at   timestamptz  DEFAULT now(),
      UNIQUE(workspace_id, date)
    )
  `);
}

// ─── GET /holidays/schedule ───────────────────────────────────────────────────
// Returns the workspace work schedule (which days are working days).
// Seeds a default Mon–Fri schedule if none exists.
router.get("/schedule", async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await db.query(
      `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1`,
      [req.workspaceId]
    );

    if (rows.length === 0) {
      // Seed default Mon–Fri
      const seeded = await db.query(
        `INSERT INTO workspace_work_schedule (workspace_id, work_days)
         VALUES ($1, ARRAY[1,2,3,4,5])
         ON CONFLICT (workspace_id) DO UPDATE SET work_days = EXCLUDED.work_days
         RETURNING work_days`,
        [req.workspaceId]
      );
      return res.json({ work_days: seeded.rows[0].work_days });
    }

    res.json({ work_days: rows[0].work_days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /holidays/schedule ───────────────────────────────────────────────────
// Admin: update which days are working days.
// Body: { work_days: [1,2,3,4,5] }  — array of DOW ints (0=Sun … 6=Sat)
router.put("/schedule", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role))
      return res.status(403).json({ error: "Admin required" });

    const { work_days } = req.body;
    if (!Array.isArray(work_days) || work_days.some(d => typeof d !== "number" || d < 0 || d > 6))
      return res.status(400).json({ error: "work_days must be an array of integers 0–6" });
    if (work_days.length === 0)
      return res.status(400).json({ error: "At least one working day is required" });

    await ensureTables();
    const { rows } = await db.query(
      `INSERT INTO workspace_work_schedule (workspace_id, work_days)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id)
       DO UPDATE SET work_days = EXCLUDED.work_days, updated_at = now()
       RETURNING work_days`,
      [req.workspaceId, work_days]
    );

    res.json({ work_days: rows[0].work_days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /holidays ────────────────────────────────────────────────────────────
// Returns holidays for the workspace.
// Optional query params: year (e.g. 2026), month (1-12)
router.get("/", async (req, res) => {
  try {
    await ensureTables();
    const { year, month } = req.query;

    let whereExtra = "";
    const params = [req.workspaceId];

    if (year && month) {
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const end   = new Date(Number(year), Number(month), 0).toISOString().slice(0, 10);
      whereExtra = ` AND date BETWEEN $2 AND $3`;
      params.push(start, end);
    } else if (year) {
      whereExtra = ` AND EXTRACT(YEAR FROM date) = $2`;
      params.push(year);
    }

    const { rows } = await db.query(
      `SELECT h.*, u.username AS created_by_name
       FROM workspace_holidays h
       LEFT JOIN users u ON u.id = h.created_by
       WHERE h.workspace_id = $1${whereExtra}
       ORDER BY h.date ASC`,
      params
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /holidays ───────────────────────────────────────────────────────────
// Admin: declare a company holiday.
// Body: { date: "2026-04-14", name: "Good Friday" }
router.post("/", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role))
      return res.status(403).json({ error: "Admin required" });

    const { date, name } = req.body;
    if (!date || !name)
      return res.status(400).json({ error: "date and name are required" });

    await ensureTables();
    const { rows } = await db.query(
      `INSERT INTO workspace_holidays (workspace_id, date, name, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, date)
       DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [req.workspaceId, date, name.trim(), req.user.id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /holidays/:id ─────────────────────────────────────────────────────
// Admin: remove a holiday.
router.delete("/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role))
      return res.status(403).json({ error: "Admin required" });

    await db.query(
      `DELETE FROM workspace_holidays WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
