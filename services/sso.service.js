// services/sso.service.js
// SAML SSO — per-workspace configuration
import db from "../db.js";
import { logAudit } from "./audit.service.js";
import { generateToken } from "./auth.service.js";
import { encryptSecret } from "../config/dataEncryption.js";

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
  const current = await getSsoConfig(workspaceId);
  const {
    provider = current?.provider || "saml",
    enabled = current?.enabled || false,
    entry_point,
    issuer,
    cert,
    sp_callback_url,
    attribute_email = current?.attribute_email || "email",
    attribute_name = current?.attribute_name || "displayName",
    force_sso = current?.force_sso || false,
    idp_issuer,
    audience,
    oidc_issuer_url,
    oidc_client_id,
    oidc_client_secret,
    oidc_scopes = current?.oidc_scopes || ["openid", "email", "profile"],
    allowed_domains = current?.allowed_domains || [],
    jit_enabled = current?.jit_enabled ?? true,
    want_authn_response_signed = current?.want_authn_response_signed || false,
  } = config;

  if (!['saml', 'oidc'].includes(provider)) throw new Error("provider must be saml or oidc");
  if (enabled && provider === "saml" && (!(entry_point || current?.entry_point) || !(issuer || current?.issuer) || !(cert || current?.cert) || !(sp_callback_url || current?.sp_callback_url))) {
    throw new Error("Enabled SAML requires entry_point, issuer, cert, and sp_callback_url");
  }
  if (enabled && provider === "oidc" && (!(oidc_issuer_url || current?.oidc_issuer_url) || !(oidc_client_id || current?.oidc_client_id) || !(sp_callback_url || current?.sp_callback_url))) {
    throw new Error("Enabled OIDC requires oidc_issuer_url, oidc_client_id, and sp_callback_url");
  }
  const normalizedDomains = [...new Set((Array.isArray(allowed_domains) ? allowed_domains : [])
    .map((domain) => String(domain).trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean))];
  const normalizedScopes = [...new Set((Array.isArray(oidc_scopes) ? oidc_scopes : [])
    .map((scope) => String(scope).trim()).filter(Boolean))];
  if (provider === "oidc" && !normalizedScopes.includes("openid")) normalizedScopes.unshift("openid");

  const row = await db.query(
    `INSERT INTO workspace_sso_configs
       (workspace_id, provider, enabled, entry_point, issuer, cert,
        sp_callback_url, attribute_email, attribute_name, force_sso,
        idp_issuer, audience, oidc_issuer_url, oidc_client_id, oidc_client_secret,
        oidc_scopes, allowed_domains, jit_enabled, want_authn_response_signed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (workspace_id) DO UPDATE SET
       provider       = EXCLUDED.provider,
       enabled        = EXCLUDED.enabled,
       entry_point    = COALESCE(EXCLUDED.entry_point, workspace_sso_configs.entry_point),
       issuer         = COALESCE(EXCLUDED.issuer, workspace_sso_configs.issuer),
       cert           = COALESCE(NULLIF(EXCLUDED.cert, ''), workspace_sso_configs.cert),
       sp_callback_url= COALESCE(EXCLUDED.sp_callback_url, workspace_sso_configs.sp_callback_url),
       attribute_email= EXCLUDED.attribute_email,
       attribute_name = EXCLUDED.attribute_name,
       force_sso      = EXCLUDED.force_sso,
       idp_issuer     = COALESCE(EXCLUDED.idp_issuer, workspace_sso_configs.idp_issuer),
       audience       = COALESCE(EXCLUDED.audience, workspace_sso_configs.audience),
       oidc_issuer_url= COALESCE(EXCLUDED.oidc_issuer_url, workspace_sso_configs.oidc_issuer_url),
       oidc_client_id = COALESCE(EXCLUDED.oidc_client_id, workspace_sso_configs.oidc_client_id),
       oidc_client_secret = COALESCE(EXCLUDED.oidc_client_secret, workspace_sso_configs.oidc_client_secret),
       oidc_scopes    = EXCLUDED.oidc_scopes,
       allowed_domains = EXCLUDED.allowed_domains,
       jit_enabled    = EXCLUDED.jit_enabled,
       want_authn_response_signed = EXCLUDED.want_authn_response_signed,
       updated_at     = NOW()
     RETURNING *`,
    [workspaceId, provider, enabled, entry_point, issuer, cert,
     sp_callback_url, attribute_email, attribute_name, force_sso,
     idp_issuer, audience, oidc_issuer_url, oidc_client_id,
     oidc_client_secret ? encryptSecret(oidc_client_secret) : null,
     normalizedScopes, normalizedDomains, jit_enabled, want_authn_response_signed]
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
  const normalizedEmail = String(email).toLowerCase().trim();
  const domain = normalizedEmail.split("@")[1];
  if (!domain) throw new Error("IdP returned an invalid email identity");
  if (config.allowed_domains?.length && !config.allowed_domains.includes(domain)) {
    throw new Error("Email domain is not allowed for this workspace");
  }

  // Find user by email within this workspace
  const row = await db.query(
    `SELECT u.*, wu.role
     FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE u.email = $2`,
    [workspaceId, normalizedEmail]
  );

  let user = row.rows[0];

  // Auto-provision if not found (JIT provisioning)
  if (!user) {
    if (config.jit_enabled === false) throw new Error("User is not provisioned for this workspace");
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
      [String(displayName).trim().slice(0, 200), normalizedEmail, workspaceId]
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
