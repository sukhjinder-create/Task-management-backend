import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import pool from "../db.js";

const router = express.Router();

/**
 * =====================================================
 * 🔐 ADMIN ATTENDANCE REPORTS
 * - Auth required
 * - Workspace required
 * - Admin only
 * - READ ONLY
 * =====================================================
 */

router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// 🔐 Admin only
router.use((req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
});


/**
 * 🔹 GET /admin/attendance
 *
 * Optional query params:
 * - from (YYYY-MM-DD)
 * - to (YYYY-MM-DD)
 * - userId
 *
 * None are mandatory.
 */
router.get("/", async (req, res) => {
  try {
    const { from, to, userId } = req.query;

    // Workspace ID is set by requireWorkspaceForUser middleware
    const workspaceId = req.workspaceId;

    if (!workspaceId) {
      return res.status(400).json({
        error: "workspaceId is required for admin reports",
      });
    }

    const conditions = [`workspace_id = $1`];
    const values = [workspaceId];

    let idx = 2;

    if (from) {
      conditions.push(`date >= $${idx++}`);
      values.push(from);
    }

    if (to) {
      conditions.push(`date <= $${idx++}`);
      values.push(to);
    }

    if (userId) {
      conditions.push(`user_id = $${idx++}`);
      values.push(userId);
    }

    const query = `
      SELECT
        user_id,
        date,
        signed_in_minutes AS total_signed_in_minutes,
        aws_minutes,
        lunch_minutes,
        available_minutes,
        screen_on_minutes,
        screen_off_minutes
      FROM attendance_daily
      WHERE ${conditions.join(" AND ")}
      ORDER BY date DESC, user_id
      LIMIT 500
    `;

    const { rows } = await pool.query(query, values);

    res.json(rows);
  } catch (err) {
    console.error("Admin attendance report error:", err);
    res.status(500).json({ error: "Failed to load attendance reports" });
  }
});

/**
 * POST /admin/attendance/backfill-channel
 *
 * One-time (idempotent) backfill: reads ALL attendance_events
 * and inserts any missing messages into the availability-updates
 * chat channel with correct historical timestamps.
 *
 * Safe to call multiple times — uses ON CONFLICT DO NOTHING
 * keyed on (channel_key, workspace_id, created_at, user_id).
 */
router.post("/backfill-channel", async (req, res) => {
  try {
    const workspaceId = req.workspaceId;

    // 1. Get or create the system user for this workspace
    const email = `ai+${workspaceId}@example.com`;
    const { rows: sysRows } = await pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (!sysRows.length) {
      return res.status(400).json({
        error: "System user not found for this workspace. Trigger any attendance action first to auto-create it.",
      });
    }

    const systemUserId = sysRows[0].id;

    // 2. Pull ALL attendance events for this workspace, ordered by time
    //    Only mirror the event types that have a visible message in the channel
    const { rows: events } = await pool.query(
      `
      SELECT
        ae.event_type,
        ae.started_at,
        u.username
      FROM attendance_events ae
      JOIN users u ON u.id = ae.user_id
      WHERE ae.workspace_id = $1
        AND ae.event_type IN ('SIGN_IN', 'SIGN_OFF', 'AWS_START', 'LUNCH_START', 'AVAILABLE')
      ORDER BY ae.started_at ASC
      `,
      [workspaceId]
    );

    if (!events.length) {
      return res.json({ backfilled: 0, message: "No attendance events found to backfill." });
    }

    // 3. Insert missing messages with correct historical timestamps
    //    Using a unique index approach: skip if a message with same
    //    channel_key + workspace_id + created_at already exists.
    let backfilled = 0;
    let skipped = 0;

    for (const ev of events) {
      const text = formatAttendanceMessage(ev.event_type, ev.username);
      if (!text) continue;

      const { rowCount } = await pool.query(
        `
        INSERT INTO chat_messages (
          id,
          channel_key,
          user_id,
          text_html,
          fallback_text,
          encrypted_json,
          workspace_id,
          created_at
        )
        VALUES (
          gen_random_uuid(),
          'availability-updates',
          $1,
          $2,
          $2,
          $3::jsonb,
          $4::uuid,
          $5
        )
        ON CONFLICT DO NOTHING
        `,
        [
          systemUserId,
          text,
          JSON.stringify({ message: text }),
          workspaceId,
          ev.started_at,
        ]
      );

      if (rowCount > 0) {
        backfilled++;
      } else {
        skipped++;
      }
    }

    return res.json({
      backfilled,
      skipped,
      message: `Backfilled ${backfilled} historical attendance messages (${skipped} already existed).`,
    });
  } catch (err) {
    console.error("Attendance channel backfill error:", err);
    res.status(500).json({ error: "Backfill failed: " + err.message });
  }
});

function formatAttendanceMessage(eventType, name) {
  switch (eventType) {
    case "SIGN_IN":     return `✅ *${name}* has *signed in* and is now available.`;
    case "SIGN_OFF":    return `👋 *${name}* has *signed off* and is no longer available.`;
    case "AWS_START":   return `⏸️ *${name}* is *Away from Screen (AWS)*.`;
    case "LUNCH_START": return `🍽️ *${name}* has started a *lunch break*.`;
    case "AVAILABLE":   return `▶️ *${name}* is *available* again.`;
    default:            return null;
  }
}

export default router;
