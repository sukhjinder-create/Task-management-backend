import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import db from "../db.js";
import { getJwtSecret } from "../config/secrets.js";
import { apiKeyHasScope, requiredScopeForRequest, validateApiKeyScopes } from "./apiKey.service.js";

const CLIENT_ID = /^asy_client_[a-f0-9]{32}$/;
const CLIENT_SECRET = /^asy_secret_[a-f0-9]{64}$/;
const TOKEN_TTL_SECONDS = 3600;

export function createServiceAccountCredentials() {
  return {
    clientId: `asy_client_${crypto.randomBytes(16).toString("hex")}`,
    clientSecret: `asy_secret_${crypto.randomBytes(32).toString("hex")}`,
  };
}

export function parseClientCredentials(authorization, body = {}) {
  let clientId = String(body.client_id || "").trim();
  let clientSecret = String(body.client_secret || "").trim();
  if (typeof authorization === "string" && authorization.startsWith("Basic ")) {
    try {
      const value = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = value.indexOf(":");
      if (separator >= 0) {
        clientId = decodeURIComponent(value.slice(0, separator));
        clientSecret = decodeURIComponent(value.slice(separator + 1));
      }
    } catch { /* invalid credentials use the standard invalid_client response */ }
  }
  return CLIENT_ID.test(clientId) && CLIENT_SECRET.test(clientSecret)
    ? { clientId, clientSecret }
    : null;
}

export async function exchangeClientCredentials({ authorization, body = {}, database = db }) {
  if (body.grant_type !== "client_credentials") {
    return { error: "unsupported_grant_type", error_description: "grant_type must be client_credentials", status: 400 };
  }
  const credentials = parseClientCredentials(authorization, body);
  if (!credentials) return { error: "invalid_client", error_description: "Client authentication failed", status: 401 };
  const { rows } = await database.query(
    `SELECT client.*, user_record.username, user_record.email, user_record.role,
            user_record.email_verified_at, user_record.disabled_at
     FROM oauth_service_accounts client
     JOIN users user_record ON user_record.workspace_id=client.workspace_id AND user_record.id=client.user_id
     JOIN workspaces workspace_record ON workspace_record.id=client.workspace_id
     WHERE client.client_id=$1 AND client.is_active=TRUE
       AND (client.expires_at IS NULL OR client.expires_at>now())
       AND COALESCE(workspace_record.status, 'active')='active' LIMIT 1`,
    [credentials.clientId]
  );
  const account = rows[0];
  if (!account || account.disabled_at || !(await bcrypt.compare(credentials.clientSecret, account.client_secret_hash))) {
    return { error: "invalid_client", error_description: "Client authentication failed", status: 401 };
  }
  let scopes = account.scopes || [];
  if (body.scope) {
    const requested = [...new Set(String(body.scope).split(/\s+/).filter(Boolean))];
    if (requested.some((scope) => !scopes.includes(scope))) {
      return { error: "invalid_scope", error_description: "Requested scope is not granted", status: 400 };
    }
    scopes = requested;
  }
  const accessToken = jwt.sign({
    sub: account.user_id,
    workspaceId: account.workspace_id,
    clientId: account.id,
    token_use: "service_account",
    scopes,
  }, getJwtSecret(), {
    audience: "asystence-api",
    issuer: "asystence",
    expiresIn: TOKEN_TTL_SECONDS,
    jwtid: crypto.randomUUID(),
  });
  await database.query("UPDATE oauth_service_accounts SET last_used_at=now() WHERE id=$1", [account.id]);
  return { access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS, scope: scopes.join(" ") };
}

export async function authenticateServiceAccountToken(decoded, req, database = db) {
  if (decoded?.token_use !== "service_account" || !decoded.clientId) return null;
  const { rows } = await database.query(
    `SELECT account.id, account.workspace_id, account.user_id, account.scopes,
            user_record.username, user_record.email, user_record.role, user_record.email_verified_at,
            user_record.disabled_at
     FROM oauth_service_accounts account
     JOIN users user_record ON user_record.workspace_id=account.workspace_id AND user_record.id=account.user_id
     WHERE account.id=$1 AND account.workspace_id=$2 AND account.is_active=TRUE
       AND (account.expires_at IS NULL OR account.expires_at>now()) LIMIT 1`,
    [decoded.clientId, decoded.workspaceId]
  );
  const account = rows[0];
  if (!account || account.disabled_at) return null;
  const tokenScopes = Array.isArray(decoded.scopes) ? decoded.scopes : [];
  const effectiveScopes = tokenScopes.filter((scope) => (account.scopes || []).includes(scope));
  const requiredScope = requiredScopeForRequest(req);
  if (!apiKeyHasScope(effectiveScopes, requiredScope)) {
    return { forbidden: true, requiredScope };
  }
  return {
    id: account.id,
    workspaceId: account.workspace_id,
    scopes: effectiveScopes,
    user: {
      id: account.user_id,
      username: account.username,
      email: account.email,
      role: account.role || "user",
      workspaceId: account.workspace_id,
      workspace_id: account.workspace_id,
      email_verified_at: account.email_verified_at,
    },
  };
}

export async function createServiceAccount({ workspaceId, userId, name, scopes, expiresAt, database = db }) {
  const credentials = createServiceAccountCredentials();
  const validatedScopes = validateApiKeyScopes(scopes);
  const result = await database.query(
    `INSERT INTO oauth_service_accounts
       (workspace_id, user_id, name, client_id, client_secret_hash, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, name, client_id, scopes, expires_at, created_at`,
    [workspaceId, userId, String(name || "").trim(), credentials.clientId,
      await bcrypt.hash(credentials.clientSecret, 10), validatedScopes, expiresAt || null]
  );
  return { ...result.rows[0], client_secret: credentials.clientSecret };
}

export const __testables = { CLIENT_ID, CLIENT_SECRET, TOKEN_TTL_SECONDS };
