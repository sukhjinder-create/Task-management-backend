import express from "express";
import axios from "axios";
import pool from "../../db.js";
import qs from "qs";   // add at top of file
import {
  resolveIntegrationWebhookBaseUrl,
  setupAsanaWebhooks,
} from "../webhooks/integration.webhook.service.js";

const router = express.Router();

const AUTH_URL = "https://app.asana.com/-/oauth_authorize";
const TOKEN_URL = "https://app.asana.com/-/oauth_token";
const ASANA_OAUTH_SCOPE =
  "tasks:read projects:read workspaces:read users:read webhooks:read webhooks:write";

/**
 * Redirect user to Asana consent
 */
router.get("/connect", async (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.status(401).send("No token provided");
  }

  const jwt = (await import("jsonwebtoken")).default;

  let decoded;
  try {
    decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "task_management_secret"
    );
  } catch {
    return res.status(401).send("Invalid token");
  }

  const workspaceId =
    decoded.workspaceId || decoded.workspace_id;

  if (!workspaceId) {
    return res.status(400).send("Workspace missing");
  }

  if (decoded.role !== "admin") {
    return res.status(403).send("Only workspace admins can connect Asana");
  }

  const redirectUrl =
    "https://app.asana.com/-/oauth_authorize?" +
    new URLSearchParams({
      client_id: process.env.ASANA_CLIENT_ID,
      redirect_uri: process.env.ASANA_REDIRECT_URI,
      response_type: "code",
      state: workspaceId,
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
    const { code, state: workspaceId } = req.query;

    if (!code) {
      return res.status(400).send("Missing OAuth code");
    }

    if (!workspaceId) {
      return res.status(400).send("Workspace missing");
    }

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
      (process.env.FRONTEND_BASE_URL || "http://localhost:5173") +
        `/admin/migrations?source=asana&connected=true&webhooks=${webhookStatus}`
    );

  } catch (err) {
    console.error("Asana OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

export default router;
