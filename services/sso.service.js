// services/sso.service.js
// SAML SSO — per-workspace configuration
import db from "../db.js";
import { logAudit } from "./audit.service.js";
import { generateToken } from "./auth.service.js";

/**
 * Get SSO config for a workspace.
 */
export async function getSsoConfig(workspaceId) {
  const row = await db.query(
    "SELECT * FROM workspace_sso_configs WHERE workspace_id = $1",
    [workspaceId]
  );
  return row.rows[0] || null;
}

/**
 * Upsert SSO config for a workspace (admin only).
 */
export async function saveSsoConfig(workspaceId, config) {
  const {
    provider = "saml",
    enabled = false,
    entry_point,
    issuer,
    cert,
    sp_callback_url,
    attribute_email = "email",
    attribute_name = "displayName",
    force_sso = false,
  } = config;

  const row = await db.query(
    `INSERT INTO workspace_sso_configs
       (workspace_id, provider, enabled, entry_point, issuer, cert,
        sp_callback_url, attribute_email, attribute_name, force_sso)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (workspace_id) DO UPDATE SET
       provider       = EXCLUDED.provider,
       enabled        = EXCLUDED.enabled,
       entry_point    = EXCLUDED.entry_point,
       issuer         = EXCLUDED.issuer,
       cert           = EXCLUDED.cert,
       sp_callback_url= EXCLUDED.sp_callback_url,
       attribute_email= EXCLUDED.attribute_email,
       attribute_name = EXCLUDED.attribute_name,
       force_sso      = EXCLUDED.force_sso,
       updated_at     = NOW()
     RETURNING *`,
    [workspaceId, provider, enabled, entry_point, issuer, cert,
     sp_callback_url, attribute_email, attribute_name, force_sso]
  );
  return row.rows[0];
}

/**
 * Process a SAML assertion after IdP redirects back.
 * Returns a JWT if user exists in the workspace.
 */
export async function processSamlAssertion(workspaceId, profile, ipAddress) {
  const config = await getSsoConfig(workspaceId);
  if (!config?.enabled) throw new Error("SSO is not enabled for this workspace");

  const email = profile[config.attribute_email] || profile.email;
  if (!email) throw new Error("IdP did not return an email attribute");

  // Find user by email within this workspace
  const row = await db.query(
    `SELECT u.*, wu.role
     FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE u.email = $2`,
    [workspaceId, email.toLowerCase().trim()]
  );

  let user = row.rows[0];

  // Auto-provision if not found (JIT provisioning)
  if (!user) {
    const displayName = profile[config.attribute_name] || profile.displayName || email.split("@")[0];
    const inserted = await db.query(
      `WITH new_user AS (
         INSERT INTO users (
           username, email, role, workspace_id,
           email_verified_at, email_verification_method
         )
         VALUES ($1, $2, 'user', $3, now(), 'sso')
         RETURNING *
       ),
       _wu AS (
         INSERT INTO workspace_users (workspace_id, user_id, role)
         SELECT $3, id, 'member' FROM new_user
         ON CONFLICT DO NOTHING
       )
       SELECT * FROM new_user`,
      [displayName, email.toLowerCase().trim(), workspaceId]
    );
    user = { ...inserted.rows[0], role: "user" };
  }

  if (!user.email_verified_at || user.email_verification_method === "legacy") {
    await db.query(
      `UPDATE users
          SET email_verified_at = now(), email_verification_method = 'sso', updated_at = now()
        WHERE id = $1`,
      [user.id]
    );
    user.email_verified_at = new Date();
    user.email_verification_method = "sso";
  }

  await logAudit({
    workspaceId, userId: user.id,
    action: "user.login.sso",
    entityType: "user", entityId: user.id,
    ipAddress,
    metadata: { provider: config.provider },
  });

  const token = generateToken({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    workspaceId,
    workspace_id: workspaceId,
    email_verified_at: user.email_verified_at,
  });

  return { token, user: { id: user.id, username: user.username, email: user.email, role: user.role, workspaceId } };
}
