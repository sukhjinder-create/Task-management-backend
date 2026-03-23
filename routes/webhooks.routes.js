// routes/webhooks.routes.js
import express from "express";
import db from "../db.js";
import { testWebhook } from "../services/webhook.service.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

const VALID_EVENTS = [
  "task.created", "task.updated", "task.deleted", "task.status_changed",
  "comment.created", "project.created", "project.updated",
  "user.joined", "user.left", "sprint.started", "sprint.completed",
  "leave.requested", "leave.approved", "leave.rejected",
  "review.submitted", "ping",
];

router.get("/", async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT id, name, url, events, is_active, last_fired_at, failure_count, created_at FROM webhooks WHERE workspace_id = $1 ORDER BY created_at DESC",
      [req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { name, url, secret, events = [] } = req.body;
    if (!name || !url) return res.status(400).json({ error: "name and url required" });
    if (!url.startsWith("https://") && !url.startsWith("http://")) return res.status(400).json({ error: "Invalid URL" });

    const validEvents = events.filter(e => VALID_EVENTS.includes(e));

    const row = await db.query(
      "INSERT INTO webhooks (workspace_id, name, url, secret, events) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.workspaceId, name, url, secret || null, validEvents]
    );

    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "webhook.create", entityType: "webhook", entityId: row.rows[0].id, newValue: { name, url } });
    res.status(201).json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { name, url, secret, events, is_active } = req.body;
    const validEvents = events ? events.filter(e => VALID_EVENTS.includes(e)) : undefined;

    const row = await db.query(
      `UPDATE webhooks SET
         name      = COALESCE($1, name),
         url       = COALESCE($2, url),
         secret    = COALESCE($3, secret),
         events    = COALESCE($4, events),
         is_active = COALESCE($5, is_active)
       WHERE id = $6 AND workspace_id = $7 RETURNING *`,
      [name, url, secret, validEvents, is_active, req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    await db.query("DELETE FROM webhooks WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/test", async (req, res) => {
  try {
    const result = await testWebhook(req.params.id, req.workspaceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/deliveries", async (req, res) => {
  try {
    const rows = await db.query(
      "SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50",
      [req.params.id]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/events/list", (_req, res) => {
  res.json(VALID_EVENTS);
});

export default router;
