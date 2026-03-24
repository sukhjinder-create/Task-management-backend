// routes/gdpr.routes.js
// GDPR compliance endpoints: data export, erasure requests, consent log
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { getClientIp, getUserAgent } from "../utils/requestContext.util.js";

const router = express.Router();

/** POST /gdpr/consent — log user consent */
router.post("/consent", async (req, res) => {
  try {
    const { type, version, consented } = req.body;
    if (!type || !version) return res.status(400).json({ error: "type and version required" });

    await db.query(
      "INSERT INTO gdpr_consents (user_id, type, version, consented, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.user.id, type, version, consented !== false, getClientIp(req), getUserAgent(req)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /gdpr/my-data — export all personal data for logged-in user */
router.get("/my-data", async (req, res) => {
  try {
    const userId = req.user.id;

    const [userRow, tasks, comments, chatMsgs, attendance, consents] = await Promise.all([
      db.query("SELECT id, username, email, role, created_at FROM users WHERE id = $1", [userId]),
      db.query("SELECT id, title, status, priority, created_at, updated_at FROM tasks WHERE created_by = $1 LIMIT 500", [userId]),
      db.query("SELECT id, content, created_at FROM comments WHERE user_id = $1 LIMIT 500", [userId]),
      db.query("SELECT id, text_html, created_at FROM chat_messages WHERE user_id = $1 LIMIT 500", [userId]),
      db.query("SELECT * FROM attendance_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500", [userId]),
      db.query("SELECT type, version, consented, created_at FROM gdpr_consents WHERE user_id = $1 ORDER BY created_at DESC", [userId]),
    ]);

    await logAudit({
      workspaceId: req.workspaceId, userId,
      action: "gdpr.data_export",
      entityType: "user", entityId: userId,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    res.json({
      exported_at: new Date().toISOString(),
      profile: userRow.rows[0],
      tasks: tasks.rows,
      comments: comments.rows,
      chat_messages: chatMsgs.rows,
      attendance: attendance.rows,
      consents: consents.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /gdpr/erasure — request account deletion */
router.post("/erasure", async (req, res) => {
  try {
    const row = await db.query(
      "INSERT INTO gdpr_erasure_requests (workspace_id, user_id) VALUES ($1,$2) RETURNING *",
      [req.workspaceId, req.user.id]
    );

    await logAudit({
      workspaceId: req.workspaceId, userId: req.user.id,
      action: "gdpr.erasure_request",
      entityType: "user", entityId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    res.json({ success: true, requestId: row.rows[0].id, message: "Your erasure request has been submitted. An admin will process it within 30 days." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /gdpr/erasure-requests — admin: list pending erasure requests */
router.get("/erasure-requests", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const rows = await db.query(
      `SELECT er.*, u.username, u.email
       FROM gdpr_erasure_requests er
       LEFT JOIN users u ON u.id = er.user_id
       WHERE er.workspace_id = $1
       ORDER BY er.requested_at DESC`,
      [req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /gdpr/erasure-requests/:id — admin: process/complete erasure */
router.patch("/erasure-requests/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { status, notes } = req.body;

    const row = await db.query(
      `UPDATE gdpr_erasure_requests SET
         status       = $1,
         notes        = $2,
         completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
       WHERE id = $3 AND workspace_id = $4 RETURNING *`,
      [status || "processing", notes || null, req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
