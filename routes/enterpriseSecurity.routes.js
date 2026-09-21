import crypto from "node:crypto";
import dns from "node:dns/promises";
import express from "express";
import { domainToASCII } from "node:url";

import db from "../db.js";
import { decryptSecret, encryptSecret } from "../config/dataEncryption.js";
import { logAudit } from "../services/audit.service.js";
import {
  ENTERPRISE_PERMISSIONS,
  isRequestIpAllowed,
  validatePermissions,
} from "../services/workspaceSecurity.service.js";
import { createServiceAccount } from "../services/serviceAccount.service.js";
import { getClientIp } from "../utils/requestContext.util.js";

const router = express.Router();
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

router.use((req, res, next) => {
  if (!["admin", "owner"].includes(req.user?.role)) return res.status(403).json({ error: "Admin required" });
  next();
});

const policyDefaults = {
  require_mfa: false,
  enforce_sso: false,
  session_max_age_minutes: 10080,
  idle_timeout_minutes: 10080,
  allowed_ip_cidrs: [],
  guest_access_enabled: true,
  api_key_max_age_days: 365,
  audit_retention_days: 365,
  data_retention_days: null,
};

router.get("/permissions", (_req, res) => res.json(ENTERPRISE_PERMISSIONS));

router.get("/service-accounts", async (req, res) => {
  const result = await db.query(
    `SELECT id, name, client_id, scopes, is_active, expires_at, last_used_at, created_at
     FROM oauth_service_accounts WHERE workspace_id=$1 ORDER BY created_at DESC`,
    [req.workspaceId]
  );
  res.json({ serviceAccounts: result.rows });
});

router.post("/service-accounts", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name || name.length > 200) throw new Error("name is required and must be 200 characters or fewer");
    const maxDaysResult = await db.query(
      "SELECT api_key_max_age_days FROM workspace_security_policies WHERE workspace_id=$1",
      [req.workspaceId]
    );
    const maxDays = Number(maxDaysResult.rows[0]?.api_key_max_age_days || 365);
    const expiresAt = req.body?.expires_at ? new Date(req.body.expires_at) : new Date(Date.now() + maxDays * 86_400_000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date() || expiresAt.getTime() > Date.now() + maxDays * 86_400_000 + 60_000) {
      throw new Error(`expires_at must be within ${maxDays} days`);
    }
    const account = await createServiceAccount({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      name,
      scopes: req.body?.scopes || ["read:tasks"],
      expiresAt: expiresAt.toISOString(),
    });
    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "service_account.create", entityType: "service_account", entityId: account.id, newValue: { name, scopes: account.scopes } });
    res.status(201).json({ ...account, warning: "Save the client secret now; it will not be shown again." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/service-accounts/:id", async (req, res) => {
  const result = await db.query(
    `UPDATE oauth_service_accounts SET is_active=FALSE
     WHERE workspace_id=$1 AND id=$2 AND is_active=TRUE RETURNING id`,
    [req.workspaceId, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Service account not found" });
  await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "service_account.revoke", entityType: "service_account", entityId: req.params.id });
  return res.status(204).end();
});

router.get("/policy", async (req, res) => {
  const result = await db.query(
    "SELECT * FROM workspace_security_policies WHERE workspace_id = $1",
    [req.workspaceId]
  );
  res.json(result.rows[0] || { workspace_id: req.workspaceId, ...policyDefaults });
});

router.put("/policy", async (req, res) => {
  try {
    const next = { ...policyDefaults, ...(req.body || {}) };
    if (!Array.isArray(next.allowed_ip_cidrs)) throw new Error("allowed_ip_cidrs must be an array");
    if (next.allowed_ip_cidrs.length) {
      await db.query("SELECT unnest($1::inet[])", [next.allowed_ip_cidrs]);
      if (!(await isRequestIpAllowed(getClientIp(req), next.allowed_ip_cidrs))) {
        throw new Error("The IP allowlist must include your current address before it can be saved");
      }
    }
    const result = await db.query(
      `INSERT INTO workspace_security_policies
         (workspace_id, require_mfa, enforce_sso, session_max_age_minutes,
          idle_timeout_minutes, allowed_ip_cidrs, guest_access_enabled,
          api_key_max_age_days, audit_retention_days, data_retention_days, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace_id) DO UPDATE SET
         require_mfa = EXCLUDED.require_mfa,
         enforce_sso = EXCLUDED.enforce_sso,
         session_max_age_minutes = EXCLUDED.session_max_age_minutes,
         idle_timeout_minutes = EXCLUDED.idle_timeout_minutes,
         allowed_ip_cidrs = EXCLUDED.allowed_ip_cidrs,
         guest_access_enabled = EXCLUDED.guest_access_enabled,
         api_key_max_age_days = EXCLUDED.api_key_max_age_days,
         audit_retention_days = EXCLUDED.audit_retention_days,
         data_retention_days = EXCLUDED.data_retention_days,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        req.workspaceId, Boolean(next.require_mfa), Boolean(next.enforce_sso),
        Number(next.session_max_age_minutes), Number(next.idle_timeout_minutes),
        next.allowed_ip_cidrs.map(String), Boolean(next.guest_access_enabled),
        Number(next.api_key_max_age_days), Number(next.audit_retention_days),
        next.data_retention_days == null ? null : Number(next.data_retention_days), req.user.id,
      ]
    );
    await logAudit({ workspaceId: req.workspaceId, userId: req.user.id, action: "security.policy.update", entityType: "workspace", entityId: req.workspaceId, newValue: result.rows[0] });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get("/domains", async (req, res) => {
  const result = await db.query(
    `SELECT id, domain, status, verified_at, created_at
       FROM workspace_domains WHERE workspace_id = $1 ORDER BY domain`,
    [req.workspaceId]
  );
  res.json(result.rows);
});

router.post("/domains", async (req, res) => {
  try {
    const domain = domainToASCII(String(req.body?.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]);
    if (!domain || domain.length > 253 || !domain.includes(".") || !/^[a-z0-9.-]+$/.test(domain)) {
      return res.status(400).json({ error: "A valid registrable domain is required" });
    }
    const token = crypto.randomBytes(24).toString("base64url");
    const result = await db.query(
      `INSERT INTO workspace_domains
         (workspace_id, domain, verification_token_hash, verification_token_ciphertext, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (domain) DO UPDATE SET
         verification_token_hash = EXCLUDED.verification_token_hash,
         verification_token_ciphertext = EXCLUDED.verification_token_ciphertext,
         status = 'pending', verified_at = NULL
       WHERE workspace_domains.workspace_id = EXCLUDED.workspace_id
       RETURNING id, domain, status, created_at`,
      [req.workspaceId, domain, hash(token), encryptSecret(token), req.user.id]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Domain is claimed by another workspace" });
    res.status(201).json({
      ...result.rows[0],
      dns_record: { type: "TXT", name: `_asystence-verification.${domain}`, value: `asystence-verification=${token}` },
    });
  } catch (error) {
    res.status(error.code === "23505" ? 409 : 400).json({ error: error.message });
  }
});

router.post("/domains/:id/verify", async (req, res) => {
  try {
    const record = await db.query(
      `SELECT * FROM workspace_domains WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!record.rows[0]) return res.status(404).json({ error: "Domain not found" });
    const token = decryptSecret(record.rows[0].verification_token_ciphertext);
    const values = (await dns.resolveTxt(`_asystence-verification.${record.rows[0].domain}`)).flat();
    if (!values.includes(`asystence-verification=${token}`)) {
      return res.status(409).json({ error: "Verification TXT record was not found" });
    }
    const verified = await db.query(
      `UPDATE workspace_domains SET status = 'verified', verified_at = now()
        WHERE id = $1 AND workspace_id = $2
        RETURNING id, domain, status, verified_at`,
      [req.params.id, req.workspaceId]
    );
    res.json(verified.rows[0]);
  } catch (error) {
    res.status(error.code === "ENOTFOUND" || error.code === "ENODATA" ? 409 : 500).json({ error: error.code === "ENOTFOUND" || error.code === "ENODATA" ? "Verification TXT record was not found" : error.message });
  }
});

router.delete("/domains/:id", async (req, res) => {
  const result = await db.query(
    "DELETE FROM workspace_domains WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [req.params.id, req.workspaceId]
  );
  res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: "Domain not found" });
});

router.get("/roles", async (req, res) => {
  const result = await db.query(
    `SELECT role.*, COUNT(member.user_id)::int AS member_count
       FROM enterprise_roles role
       LEFT JOIN workspace_users member
         ON member.workspace_id = role.workspace_id AND member.enterprise_role_id = role.id
      WHERE role.workspace_id = $1
      GROUP BY role.id ORDER BY role.name`,
    [req.workspaceId]
  );
  res.json(result.rows);
});

router.post("/roles", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const baseRole = String(req.body?.base_role || "user");
    if (!["user", "manager", "admin"].includes(baseRole)) return res.status(400).json({ error: "Invalid base_role" });
    const permissions = validatePermissions(req.body?.permissions || []);
    const result = await db.query(
      `INSERT INTO enterprise_roles (workspace_id, name, description, base_role, permissions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, name, req.body?.description || null, baseRole, permissions, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(error.code === "23505" ? 409 : 400).json({ error: error.message });
  }
});

router.put("/roles/:id", async (req, res) => {
  try {
    const permissions = validatePermissions(req.body?.permissions || []);
    const baseRole = String(req.body?.base_role || "user");
    if (!["user", "manager", "admin"].includes(baseRole)) return res.status(400).json({ error: "Invalid base_role" });
    const result = await db.query(
      `UPDATE enterprise_roles SET name = $1, description = $2, base_role = $3,
              permissions = $4, updated_at = now()
        WHERE id = $5 AND workspace_id = $6 RETURNING *`,
      [String(req.body?.name || "").trim(), req.body?.description || null, baseRole, permissions, req.params.id, req.workspaceId]
    );
    res.status(result.rows[0] ? 200 : 404).json(result.rows[0] || { error: "Role not found" });
  } catch (error) {
    res.status(error.code === "23505" ? 409 : 400).json({ error: error.message });
  }
});

router.delete("/roles/:id", async (req, res) => {
  const result = await db.query(
    "DELETE FROM enterprise_roles WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [req.params.id, req.workspaceId]
  );
  res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: "Role not found" });
});

router.put("/roles/:id/members/:userId", async (req, res) => {
  const result = await db.query(
    `UPDATE workspace_users member SET enterprise_role_id = role.id
       FROM enterprise_roles role
      WHERE member.user_id = $1 AND member.workspace_id = $2
        AND role.id = $3 AND role.workspace_id = member.workspace_id
      RETURNING member.user_id, member.enterprise_role_id`,
    [req.params.userId, req.workspaceId, req.params.id]
  );
  res.status(result.rows[0] ? 200 : 404).json(result.rows[0] || { error: "Role or member not found" });
});

router.delete("/roles/members/:userId", async (req, res) => {
  const result = await db.query(
    `UPDATE workspace_users SET enterprise_role_id = NULL
      WHERE user_id = $1 AND workspace_id = $2 RETURNING user_id`,
    [req.params.userId, req.workspaceId]
  );
  res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: "Member not found" });
});

router.get("/scim-tokens", async (req, res) => {
  const result = await db.query(
    `SELECT id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at
       FROM scim_tokens WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [req.workspaceId]
  );
  res.json(result.rows);
});

router.post("/scim-tokens", async (req, res) => {
  const policy = await db.query(
    "SELECT api_key_max_age_days FROM workspace_security_policies WHERE workspace_id = $1",
    [req.workspaceId]
  );
  const maxDays = Number(policy.rows[0]?.api_key_max_age_days) || 365;
  const requestedDays = Math.max(1, Number(req.body?.expires_in_days) || maxDays);
  const days = Math.min(requestedDays, maxDays);
  const token = `scim_${crypto.randomBytes(32).toString("hex")}`;
  const result = await db.query(
    `INSERT INTO scim_tokens
       (workspace_id, name, token_hash, token_prefix, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,now() + ($6 * interval '1 day'))
     RETURNING id, name, token_prefix, expires_at, created_at`,
    [req.workspaceId, String(req.body?.name || "Directory provider").trim(), hash(token), token.slice(0, 13), req.user.id, days]
  );
  res.status(201).json({ ...result.rows[0], token, warning: "Copy this SCIM token now; it will not be shown again." });
});

router.delete("/scim-tokens/:id", async (req, res) => {
  const result = await db.query(
    `UPDATE scim_tokens SET revoked_at = now()
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id`,
    [req.params.id, req.workspaceId]
  );
  res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: "SCIM token not found" });
});

router.get("/sessions", async (req, res) => {
  const result = await db.query(
    `SELECT session.id, session.user_id, app_user.username, app_user.email,
            session.ip_address, session.user_agent, session.created_at,
            session.last_seen_at, session.expires_at, session.absolute_expires_at
       FROM user_sessions session JOIN users app_user ON app_user.id = session.user_id
      WHERE session.workspace_id = $1 AND session.expires_at > now()
      ORDER BY session.last_seen_at DESC`,
    [req.workspaceId]
  );
  res.json(result.rows);
});

router.delete("/sessions/:id", async (req, res) => {
  const result = await db.query(
    "DELETE FROM user_sessions WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [req.params.id, req.workspaceId]
  );
  res.status(result.rows[0] ? 200 : 404).json(result.rows[0] ? { success: true } : { error: "Session not found" });
});

export default router;
