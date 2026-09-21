// routes/apiKeys.routes.js
// API key management for external integrations
import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import db from "../db.js";
import { logAudit } from "../services/audit.service.js";
import {
  SUPPORTED_API_KEY_SCOPES,
  validateApiKeyScopes,
} from "../services/apiKey.service.js";

const router = express.Router();

router.get("/scopes", (_req, res) => res.json(SUPPORTED_API_KEY_SCOPES));

/** GET /api-keys — list keys for workspace */
router.get("/", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT ak.id, ak.name, ak.key_prefix, ak.scopes, ak.last_used_at, ak.expires_at, ak.is_active, ak.created_at,
              u.username AS created_by_name
       FROM api_keys ak
       LEFT JOIN users u ON u.id = ak.user_id
       WHERE ak.workspace_id = $1
       ORDER BY ak.created_at DESC`,
      [req.workspaceId]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api-keys — create a new API key */
router.post("/", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const { name, scopes = ["read:tasks"], expires_at } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const validatedScopes = validateApiKeyScopes(scopes);
    if (expires_at && Number.isNaN(Date.parse(expires_at))) {
      return res.status(400).json({ error: "expires_at must be a valid date" });
    }
    const policy = await db.query(
      "SELECT api_key_max_age_days FROM workspace_security_policies WHERE workspace_id=$1",
      [req.workspaceId]
    );
    const maxAgeDays = Number(policy.rows[0]?.api_key_max_age_days || 365);
    const maximumExpiry = Date.now() + maxAgeDays * 86_400_000;
    const expiresAt = expires_at ? new Date(expires_at) : new Date(maximumExpiry);
    if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > maximumExpiry + 60_000) {
      return res.status(400).json({ error: `expires_at must be within ${maxAgeDays} days` });
    }

    const rawKey = "asy_" + crypto.randomBytes(32).toString("hex");
    const keyHash = await bcrypt.hash(rawKey, 10);
    const keyPrefix = rawKey.slice(0, 12);

    const row = await db.query(
      `INSERT INTO api_keys (workspace_id, user_id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, key_prefix, scopes, expires_at, created_at`,
      [req.workspaceId, req.user.id, String(name).trim(), keyHash, keyPrefix, validatedScopes, expiresAt.toISOString()]
    );

    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "api_key.create", entityType: "api_key", entityId: row.rows[0].id, newValue: { name } });

    // Return raw key ONCE — never stored again
    res.status(201).json({ ...row.rows[0], key: rawKey, warning: "Save this key — it will not be shown again." });
  } catch (err) {
    res.status(err.message?.startsWith("Unsupported") || err.message?.includes("scope") ? 400 : 500).json({ error: err.message });
  }
});

/** DELETE /api-keys/:id */
router.delete("/:id", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    await db.query("DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api-keys/:id/toggle */
router.patch("/:id/toggle", async (req, res) => {
  try {
    if (!["admin", "owner"].includes(req.user.role)) return res.status(403).json({ error: "Admin required" });
    const row = await db.query(
      "UPDATE api_keys SET is_active = NOT is_active WHERE id = $1 AND workspace_id = $2 RETURNING id, is_active",
      [req.params.id, req.workspaceId]
    );
    res.json(row.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
