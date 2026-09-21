// routes/gdpr.routes.js
// GDPR compliance endpoints: data export, erasure requests, consent log
import express from "express";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import { getClientIp, getUserAgent } from "../utils/requestContext.util.js";
import { collectPersonalData, executeErasure } from "../services/privacy.service.js";

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
    const exportData = await collectPersonalData({ userId, workspaceId: req.workspaceId });

    await logAudit({
      workspaceId: req.workspaceId, userId,
      action: "gdpr.data_export",
      entityType: "user", entityId: userId,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    res.set("Cache-Control", "no-store").json(exportData);
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

    if (status === "completed") {
      if (req.body?.confirm !== "ERASE") {
        return res.status(400).json({ error: "confirm must equal ERASE to execute anonymization" });
      }
      return res.json(await executeErasure({
        requestId: req.params.id,
        workspaceId: req.workspaceId,
        processedBy: req.user.id,
        notes,
      }));
    }
    if (!['pending', 'processing'].includes(status || "processing")) {
      return res.status(400).json({ error: "status must be pending, processing, or completed" });
    }

    const row = await db.query(
      `UPDATE gdpr_erasure_requests SET
         status       = $1,
         notes        = $2
       WHERE id = $3 AND workspace_id = $4 RETURNING *`,
      [status || "processing", notes || null, req.params.id, req.workspaceId]
    );
    res.status(row.rows[0] ? 200 : 404).json(row.rows[0] || { error: "Erasure request not found" });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.hold ? { legal_hold: err.hold } : {}) });
  }
});

router.get("/legal-holds", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const result = await db.query(
      `SELECT hold.*, app_user.username, app_user.email
         FROM privacy_legal_holds hold JOIN users app_user ON app_user.id = hold.user_id
        WHERE hold.workspace_id = $1 ORDER BY hold.active DESC, hold.created_at DESC`,
      [req.workspaceId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/legal-holds", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    if (!req.body?.user_id || !String(req.body?.reason || "").trim()) return res.status(400).json({ error: "user_id and reason are required" });
    const result = await db.query(
      `INSERT INTO privacy_legal_holds (workspace_id, user_id, reason, reference, created_by)
       SELECT $1, id, $3, $4, $5 FROM users WHERE id = $2 AND workspace_id = $1
       RETURNING *`,
      [req.workspaceId, req.body.user_id, String(req.body.reason).trim(), req.body.reference || null, req.user.id]
    );
    if (result.rows[0]) await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "privacy.legal_hold.create", entityType: "privacy_legal_hold", entityId: result.rows[0].id, newValue: { userId: req.body.user_id, reason: String(req.body.reason).trim(), reference: req.body.reference || null } });
    res.status(result.rows[0] ? 201 : 404).json(result.rows[0] || { error: "User not found" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/legal-holds/:id/release", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const result = await db.query(
      `UPDATE privacy_legal_holds SET active = false, released_by = $1, released_at = now()
        WHERE id = $2 AND workspace_id = $3 AND active = true RETURNING *`,
      [req.user.id, req.params.id, req.workspaceId]
    );
    if (result.rows[0]) await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "privacy.legal_hold.release", entityType: "privacy_legal_hold", entityId: req.params.id });
    res.status(result.rows[0] ? 200 : 404).json(result.rows[0] || { error: "Active legal hold not found" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
