import express from "express";
import axios from "axios";
import pool from "../../db.js";
import qs from "qs";   // add at top of file
import jwt from "jsonwebtoken";
import {
  resolveIntegrationWebhookBaseUrl,
  setupAsanaWebhooks,
} from "../webhooks/integration.webhook.service.js";
import { getJwtSecret } from "../../config/secrets.js";
import { getFrontendBaseUrl } from "../../config/environment.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";

const router = express.Router();

const AUTH_URL = "https://app.asana.com/-/oauth_authorize";
const TOKEN_URL = "https://app.asana.com/-/oauth_token";
const ASANA_OAUTH_SCOPE =
  "tasks:read projects:read workspaces:read users:read webhooks:read webhooks:write";

/**
 * Redirect user to Asana consent
 */
function authenticateConnect(req, res, next) {
  // Temporary compatibility for already-loaded browser bundles. Removed after
  // the cookie-auth frontend is live; new clients never put credentials in URLs.
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return authMiddleware(req, res, next);
}

router.get("/connect", authenticateConnect, async (req, res) => {
  const workspaceId = req.workspaceId;
  if (req.user.role !== "admin") {
    return res.status(403).send("Only workspace admins can connect Asana");
  }

  const state = jwt.sign(
    { workspaceId, userId: req.user.id, purpose: "asana_connect" },
    getJwtSecret(),
    { expiresIn: "10m", audience: "asana-oauth", issuer: "asystence-api" }
  );

  const redirectUrl =
    "https://app.asana.com/-/oauth_authorize?" +
    new URLSearchParams({
      client_id: process.env.ASANA_CLIENT_ID,
      redirect_uri: process.env.ASANA_REDIRECT_URI,
      response_type: "code",
      state,
      scope: ASANA_OAUTH_SCOPE,
    });

  res.redirect(redirectUrl);
});

/**
 * OAuth callback
 */
router.get("/callback", async (req, res) => {
  console.log("🔥 ASANA CALLBACK HIT", req.query);
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send("Missing OAuth code");
    }

    let oauthState;
    try {
      oauthState = jwt.verify(state, getJwtSecret(), {
        audience: "asana-oauth",
        issuer: "asystence-api",
      });
    } catch {
      return res.status(400).send("Invalid or expired OAuth state");
    }
    if (oauthState?.purpose !== "asana_connect" || !oauthState.workspaceId) {
      return res.status(400).send("Invalid OAuth state");
    }
    const workspaceId = oauthState.workspaceId;

    // -----------------------------
    // ONLY FIRST TIME REACHES HERE
    // -----------------------------

    const tokenRes = await axios.post(
  "https://app.asana.com/-/oauth_token",
  qs.stringify({
    grant_type: "authorization_code",
    client_id: process.env.ASANA_CLIENT_ID,
    client_secret: process.env.ASANA_CLIENT_SECRET,
    redirect_uri: process.env.ASANA_REDIRECT_URI,
    code,
  }),
  {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  }
);

    const tokens = tokenRes.data;
    console.log("Saving Asana tokens for workspace:", workspaceId);
    await pool.query(
  `
  INSERT INTO workspace_integrations
    (workspace_id, provider, config)
  VALUES ($1, 'asana', $2::jsonb)

  ON CONFLICT (workspace_id, provider)
  DO UPDATE SET
    config = EXCLUDED.config,
    updated_at = NOW()
  `,
  [
    workspaceId,
    JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000
    })
  ]
);

    console.log("✅ Asana connected successfully");

    let webhookStatus = "not_setup";
    try {
      const publicBaseUrl = resolveIntegrationWebhookBaseUrl(req);
      const webhookResult = await setupAsanaWebhooks({
        workspaceId,
        publicBaseUrl,
      });
      webhookStatus = webhookResult.status || "active";
    } catch (webhookErr) {
      webhookStatus = "setup_failed";
      console.warn(
        "Asana webhook setup failed:",
        webhookErr.response?.data || webhookErr.message
      );
    }

    return res.redirect(
      getFrontendBaseUrl() +
        `/admin/migrations?source=asana&connected=true&webhooks=${webhookStatus}`
    );

  } catch (err) {
    console.error("Asana OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

export default router;
