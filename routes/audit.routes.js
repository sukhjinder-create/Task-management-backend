// routes/audit.routes.js
import express from "express";
import { getAuditLogs } from "../services/audit.service.js";

const router = express.Router();

/**
 * GET /audit
 * Query audit logs for the workspace.
 * Admin-only.
 */
router.get("/", async (req, res) => {
  try {
    const { workspaceId, user } = req;
    if (!["admin", "owner"].includes(user.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

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
