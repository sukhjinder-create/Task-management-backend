// routes/audit.routes.js
import express from "express";
import { exportAuditLogs, getAuditLogs, verifyAuditChain } from "../services/audit.service.js";

const router = express.Router();

router.use((req, res, next) => {
  if (!["admin", "owner"].includes(req.user?.role)) return res.status(403).json({ error: "Admin access required" });
  next();
});

router.get("/integrity", async (req, res) => {
  try {
    const result = await verifyAuditChain(req.workspaceId);
    res.status(result.valid ? 200 : 409).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/export", async (req, res) => {
  try {
    const rows = await exportAuditLogs({ workspaceId: req.workspaceId, ...req.query });
    const format = String(req.query.format || "jsonl").toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    res.set("Cache-Control", "no-store");
    if (format === "csv") {
      const fields = ["id", "created_at", "chain_sequence", "event_hash", "user_id", "username", "email", "action", "entity_type", "entity_id", "ip_address", "user_agent", "metadata"];
      const csv = [fields.join(","), ...rows.map((row) => fields.map((field) => {
        const value = typeof row[field] === "object" && row[field] !== null ? JSON.stringify(row[field]) : String(row[field] ?? "");
        return `"${value.replaceAll('"', '""')}"`;
      }).join(","))].join("\n");
      return res.type("text/csv").attachment(`asystence-audit-${date}.csv`).send(csv);
    }
    if (format !== "jsonl") return res.status(400).json({ error: "format must be csv or jsonl" });
    return res.type("application/x-ndjson").attachment(`asystence-audit-${date}.jsonl`)
      .send(rows.map((row) => JSON.stringify(row)).join("\n"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /audit
 * Query audit logs for the workspace.
 * Admin-only.
 */
router.get("/", async (req, res) => {
  try {
    const { workspaceId } = req;
    const {
      userId, action, entityType, entityId,
      startDate, endDate,
      page, pageSize,
      limit = 50, offset = 0,
    } = req.query;

    const result = await getAuditLogs({
      workspaceId,
      userId,
      action,
      entityType,
      entityId,
      startDate,
      endDate,
      page,
      pageSize,
      limit: Math.min(parseInt(limit) || 50, 200),
      offset: parseInt(offset) || 0,
    });

    res.json(result);
  } catch (err) {
    console.error("Audit logs error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
