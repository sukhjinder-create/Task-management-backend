// routes/sso.routes.js
// SAML SSO endpoints — /auth/sso/*
import express from "express";
import { createDecipheriv } from "crypto";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  getSsoConfig, saveSsoConfig, processSamlAssertion,
} from "../services/sso.service.js";
import { getClientIp } from "../utils/requestContext.util.js";

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ─── ADMIN: Get / Save SSO config ─────────────────────────────────────────────

router.get(
  "/config",
  authMiddleware,
  requireWorkspaceForUser,
  async (req, res) => {
    try {
      if (!["admin", "owner"].includes(req.user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const config = await getSsoConfig(req.workspaceId);
      // Don't expose cert/private key in full; mask it
      if (config?.cert) {
        config.cert_snippet = config.cert.slice(0, 40) + "...";
      }
      res.json(config || { enabled: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.put(
  "/config",
  authMiddleware,
  requireWorkspaceForUser,
  async (req, res) => {
    try {
      if (!["admin", "owner"].includes(req.user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const config = await saveSsoConfig(req.workspaceId, req.body);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── SAML FLOW ─────────────────────────────────────────────────────────────────
// These routes are public (no auth middleware) — they're the IdP redirect targets

/**
 * GET /auth/sso/saml/initiate?workspaceId=xxx
 * Redirect user to IdP.
 * Uses a simple redirect-based flow compatible with most IdPs without passport-saml.
 */
router.get("/saml/initiate", async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

    const config = await getSsoConfig(workspaceId);
    if (!config?.enabled || !config.entry_point) {
      return res.status(404).json({ error: "SSO not configured for this workspace" });
    }

    // Build SAML AuthnRequest redirect URL
    const acsUrl = config.sp_callback_url || `${req.protocol}://${req.get("host")}/auth/sso/saml/callback`;
    const authnRequest = Buffer.from(
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
        ID="_${Date.now()}" Version="2.0"
        IssueInstant="${new Date().toISOString()}"
        AssertionConsumerServiceURL="${acsUrl}"
        ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
        <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${config.issuer || acsUrl}</saml:Issuer>
      </samlp:AuthnRequest>`
    ).toString("base64");

    const redirectUrl = `${config.entry_point}?SAMLRequest=${encodeURIComponent(authnRequest)}&RelayState=${encodeURIComponent(workspaceId)}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error("SSO initiate error:", err);
    res.redirect(`${FRONTEND_URL}/login?error=sso_error`);
  }
});

/**
 * POST /auth/sso/saml/callback
 * IdP posts the SAML response here.
 * For production, use passport-saml for signature verification.
 */
router.post("/saml/callback", async (req, res) => {
  try {
    const { SAMLResponse, RelayState } = req.body;
    if (!SAMLResponse) return res.status(400).json({ error: "Missing SAMLResponse" });

    const workspaceId = RelayState;
    if (!workspaceId) return res.status(400).json({ error: "Missing RelayState (workspaceId)" });

    // Decode and parse the SAML response
    const decoded = Buffer.from(SAMLResponse, "base64").toString("utf8");

    // Extract email from SAML assertion attributes (basic XML parsing)
    const emailMatch = decoded.match(
      /NameID[^>]*>([^<]+)<\/(?:saml:|saml2:)?NameID>/i
    ) || decoded.match(/<Attribute Name="email"[^>]*>\s*<AttributeValue[^>]*>([^<]+)<\/AttributeValue>/i);

    const nameMatch = decoded.match(
      /<Attribute Name="displayName"[^>]*>\s*<AttributeValue[^>]*>([^<]+)<\/AttributeValue>/i
    ) || decoded.match(
      /<Attribute Name="http:\/\/schemas.microsoft.com\/identity\/claims\/displayname"[^>]*>\s*<AttributeValue[^>]*>([^<]+)<\/AttributeValue>/i
    );

    const profile = {
      email: emailMatch?.[1]?.trim(),
      displayName: nameMatch?.[1]?.trim(),
    };

    if (!profile.email) {
      return res.redirect(`${FRONTEND_URL}/login?error=sso_no_email`);
    }

    const { token, user } = await processSamlAssertion(workspaceId, profile, getClientIp(req));

    const params = new URLSearchParams({ token, user: JSON.stringify(user) });
    res.redirect(`${FRONTEND_URL}/auth/callback?${params}`);
  } catch (err) {
    console.error("SAML callback error:", err.message);
    const msg = encodeURIComponent(err.message);
    res.redirect(`${FRONTEND_URL}/login?error=${msg}`);
  }
});

export default router;
