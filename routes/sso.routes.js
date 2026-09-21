import express from "express";
import crypto from "node:crypto";

import db from "../db.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { createHandoffCode } from "../services/authHandoff.service.js";
import { getSsoConfig, processSamlAssertion, saveSsoConfig } from "../services/sso.service.js";
import {
  createOidcAuthorizationUrl,
  createSamlAuthorizationUrl,
  createSamlClient,
  validateOidcResponse,
  validateSamlResponse,
  verifySsoRelayState,
} from "../services/ssoProtocol.service.js";
import { getClientIp } from "../utils/requestContext.util.js";

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

function adminOnly(req, res, next) {
  if (!["admin", "owner"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function publicConfig(config) {
  if (!config) return { enabled: false };
  const { cert, oidc_client_secret, ...safe } = config;
  return {
    ...safe,
    cert_configured: Boolean(cert),
    cert_snippet: cert ? `${cert.slice(0, 40)}...` : null,
    oidc_client_secret_configured: Boolean(oidc_client_secret),
  };
}

function callbackUrl(req) {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

async function finishLogin(req, res, workspaceId, profile) {
  const { user } = await processSamlAssertion(workspaceId, profile, getClientIp(req));
  const { code } = await createHandoffCode(user.id, workspaceId, { ip: getClientIp(req) });
  const params = new URLSearchParams({ code, flow: "sso" });
  return res.redirect(`${FRONTEND_URL}/auth/callback?${params}`);
}

router.get("/config", authMiddleware, requireWorkspaceForUser, adminOnly, async (req, res) => {
  try {
    res.json(publicConfig(await getSsoConfig(req.workspaceId)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/config", authMiddleware, requireWorkspaceForUser, adminOnly, async (req, res) => {
  try {
    res.json(publicConfig(await saveSsoConfig(req.workspaceId, req.body || {})));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get("/saml/metadata", async (req, res) => {
  try {
    const config = await getSsoConfig(req.query.workspaceId);
    if (!config?.enabled || config.provider !== "saml") return res.status(404).send("SSO configuration not found");
    res.type("application/samlmetadata+xml").send(createSamlClient(config).generateServiceProviderMetadata(null));
  } catch {
    res.status(400).send("Invalid SSO configuration");
  }
});

router.get("/saml/initiate", async (req, res) => {
  try {
    const config = await getSsoConfig(req.query.workspaceId);
    if (!config?.enabled || config.provider !== "saml") {
      return res.status(404).json({ error: "SAML is not configured for this workspace" });
    }
    res.redirect(await createSamlAuthorizationUrl(config));
  } catch (error) {
    console.error("SAML initiate error:", error.message);
    res.redirect(`${FRONTEND_URL}/login?error=sso_unavailable`);
  }
});

router.post("/saml/callback", async (req, res) => {
  try {
    if (!req.body?.SAMLResponse || !req.body?.RelayState) {
      return res.status(400).json({ error: "Missing SAML response or state" });
    }
    // The signed RelayState is verified before its workspace identifier is used
    // to load tenant configuration.
    const tokenPayload = verifySsoRelayState(req.body.RelayState, "saml");
    const config = await getSsoConfig(tokenPayload.workspaceId);
    if (!config?.enabled || config.provider !== "saml") throw new Error("SAML is not enabled");
    const profile = await validateSamlResponse(config, req.body);
    return finishLogin(req, res, config.workspace_id, profile);
  } catch (error) {
    console.error("SAML callback rejected:", error.message);
    return res.redirect(`${FRONTEND_URL}/login?error=sso_failed`);
  }
});

router.get("/oidc/initiate", async (req, res) => {
  try {
    const config = await getSsoConfig(req.query.workspaceId);
    if (!config?.enabled || config.provider !== "oidc") {
      return res.status(404).json({ error: "OIDC is not configured for this workspace" });
    }
    res.redirect(await createOidcAuthorizationUrl(config, { ipAddress: getClientIp(req) }));
  } catch (error) {
    console.error("OIDC initiate error:", error.message);
    res.redirect(`${FRONTEND_URL}/login?error=sso_unavailable`);
  }
});

router.get("/oidc/callback", async (req, res) => {
  try {
    if (!req.query.state || !req.query.code) throw new Error("Missing OIDC response or state");
    // Workspace lookup is constrained by the one-time state row. Querying it
    // does not consume it; validateOidcResponse performs the atomic consume.
    const stateHash = crypto.createHash("sha256").update(String(req.query.state)).digest("hex");
    const stateRow = await db.query(
      `SELECT workspace_id FROM oidc_auth_states
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [stateHash]
    );
    const config = await getSsoConfig(stateRow.rows[0]?.workspace_id);
    if (!config?.enabled || config.provider !== "oidc") throw new Error("OIDC is not enabled");
    const claims = await validateOidcResponse(config, callbackUrl(req), req.query.state);
    return finishLogin(req, res, config.workspace_id, {
      email: claims.email,
      displayName: claims.name || claims.preferred_username || String(claims.email).split("@")[0],
      subject: claims.sub,
    });
  } catch (error) {
    console.error("OIDC callback rejected:", error.message);
    return res.redirect(`${FRONTEND_URL}/login?error=sso_failed`);
  }
});

export default router;
