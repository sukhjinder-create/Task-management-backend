import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { SAML } from "@node-saml/node-saml";
import * as oidc from "openid-client";

import db from "../db.js";
import { getJwtSecret } from "../config/secrets.js";
import { decryptSecret } from "../config/dataEncryption.js";
import { assertSafeUrl, safeFetch } from "../integrations/core/safeFetch.js";

const REQUEST_TTL_MS = 5 * 60_000;

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

class PostgresSamlCache {
  constructor(workspaceId, database = db) {
    this.workspaceId = workspaceId;
    this.database = database;
  }

  async saveAsync(key, value) {
    const createdAt = Date.now();
    await this.database.query(
      `INSERT INTO saml_request_cache (workspace_id, key_hash, value, expires_at)
       VALUES ($1,$2,$3,now() + ($4 * interval '1 millisecond'))
       ON CONFLICT (workspace_id, key_hash) DO UPDATE
         SET value = EXCLUDED.value, created_at = now(), expires_at = EXCLUDED.expires_at`,
      [this.workspaceId, hash(key), value, REQUEST_TTL_MS]
    );
    return { value, createdAt };
  }

  async getAsync(key) {
    const result = await this.database.query(
      `SELECT value FROM saml_request_cache
        WHERE workspace_id = $1 AND key_hash = $2 AND expires_at > now()`,
      [this.workspaceId, hash(key)]
    );
    return result.rows[0]?.value || null;
  }

  async removeAsync(key) {
    if (!key) return null;
    const result = await this.database.query(
      `DELETE FROM saml_request_cache
        WHERE workspace_id = $1 AND key_hash = $2
        RETURNING value`,
      [this.workspaceId, hash(key)]
    );
    return result.rows[0]?.value || null;
  }
}

export function signSsoRelayState(workspaceId, provider) {
  return jwt.sign(
    { workspaceId, provider, purpose: "enterprise_sso", nonce: crypto.randomBytes(16).toString("base64url") },
    getJwtSecret(),
    { expiresIn: "5m", audience: "asystence-sso", issuer: "asystence-api" }
  );
}

export function verifySsoRelayState(token, expectedProvider) {
  const state = jwt.verify(token, getJwtSecret(), {
    audience: "asystence-sso",
    issuer: "asystence-api",
  });
  if (state?.purpose !== "enterprise_sso" || state?.provider !== expectedProvider || !state?.workspaceId) {
    throw new Error("Invalid SSO state");
  }
  return state;
}

export function createSamlClient(config, database = db) {
  if (!config?.entry_point || !config?.issuer || !config?.cert || !config?.sp_callback_url) {
    throw new Error("SAML configuration is incomplete");
  }
  return new SAML({
    callbackUrl: config.sp_callback_url,
    entryPoint: config.entry_point,
    issuer: config.issuer,
    audience: config.audience || config.issuer,
    idpIssuer: config.idp_issuer || undefined,
    idpCert: config.cert,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: config.want_authn_response_signed === true,
    validateInResponseTo: "always",
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    acceptedClockSkewMs: 120_000,
    maxAssertionAgeMs: REQUEST_TTL_MS,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    cacheProvider: new PostgresSamlCache(config.workspace_id, database),
  });
}

export async function createSamlAuthorizationUrl(config, database = db) {
  await assertSafeUrl(config.entry_point);
  const relayState = signSsoRelayState(config.workspace_id, "saml");
  return createSamlClient(config, database).getAuthorizeUrlAsync(relayState, undefined, {});
}

export async function validateSamlResponse(config, body, database = db) {
  const state = verifySsoRelayState(body?.RelayState, "saml");
  if (state.workspaceId !== config.workspace_id) throw new Error("SSO workspace mismatch");
  const { profile, loggedOut } = await createSamlClient(config, database)
    .validatePostResponseAsync({ SAMLResponse: body?.SAMLResponse });
  if (loggedOut || !profile) throw new Error("SAML response did not contain an identity");
  return profile;
}

async function oidcConfiguration(config) {
  await assertSafeUrl(config.oidc_issuer_url);
  const secret = decryptSecret(config.oidc_client_secret) || undefined;
  return oidc.discovery(
    new URL(config.oidc_issuer_url),
    config.oidc_client_id,
    undefined,
    secret ? oidc.ClientSecretPost(secret) : undefined,
    { [oidc.customFetch]: safeFetch, timeout: 15 }
  );
}

export async function createOidcAuthorizationUrl(config, { ipAddress = null, returnTo = null, database = db } = {}) {
  if (!config?.oidc_issuer_url || !config?.oidc_client_id || !config?.sp_callback_url) {
    throw new Error("OIDC configuration is incomplete");
  }
  const client = await oidcConfiguration(config);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  await database.query(
    `INSERT INTO oidc_auth_states
       (state_hash, workspace_id, code_verifier, nonce, return_to, created_ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,now() + ($7 * interval '1 millisecond'))`,
    [hash(state), config.workspace_id, verifier, nonce, returnTo, ipAddress, REQUEST_TTL_MS]
  );
  return oidc.buildAuthorizationUrl(client, {
    redirect_uri: config.sp_callback_url,
    scope: (config.oidc_scopes || ["openid", "email", "profile"]).join(" "),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).href;
}

export async function validateOidcResponse(config, callbackUrl, state, database = db) {
  const consumed = await database.query(
    `UPDATE oidc_auth_states
        SET consumed_at = now()
      WHERE state_hash = $1 AND workspace_id = $2
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING code_verifier, nonce`,
    [hash(state), config.workspace_id]
  );
  const authState = consumed.rows[0];
  if (!authState) throw new Error("Invalid or expired OIDC state");

  const client = await oidcConfiguration(config);
  const tokens = await oidc.authorizationCodeGrant(client, new URL(callbackUrl), {
    pkceCodeVerifier: authState.code_verifier,
    expectedState: state,
    expectedNonce: authState.nonce,
  });
  const claims = tokens.claims();
  if (!claims?.sub || !claims?.email || claims.email_verified === false) {
    throw new Error("OIDC provider did not return a verified email identity");
  }
  return claims;
}

export { PostgresSamlCache, REQUEST_TTL_MS };
