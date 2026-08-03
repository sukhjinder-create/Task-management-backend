// integrations/custom/customWebhook.receiver.js
//
// Public inbound webhook endpoint for admin-defined platforms — the real-time
// path that lets a custom provider skip waiting for reconciliation.
//
// Unauthenticated by necessity (external tools cannot hold a user session), so
// every request is verified against a per-endpoint secret. Deliberately NOT one
// shared global secret: a leak from one workspace's tool must not let an
// attacker post events into another workspace.

import express from "express";
import crypto from "node:crypto";
import pool from "../../db.js";
import { customProviderKey } from "../core/providerCapabilities.js";
import { recordWebhookEvent, getSyncConfig, isProjectInScope } from "../sync/integration.syncConfig.repository.js";
import { getPath } from "../core/taskNormalizer.js";

const router = express.Router();

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  // Length check first — timingSafeEqual throws on mismatched lengths — but the
  // comparison itself stays constant-time so the secret can't be guessed byte
  // by byte from response timing.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyHmac(secret, rawBody, provided) {
  if (!rawBody) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(expected, String(provided || "").replace(/^sha256=/i, "").trim());
}

/**
 * POST /integration-webhooks/custom/:workspaceId/:slug
 *
 * Always responds 200 on success without echoing anything about the workspace
 * or provider, so this endpoint can't be used to probe which workspaces or
 * connectors exist.
 */
router.post("/custom/:workspaceId/:slug", async (req, res) => {
  const { workspaceId, slug } = req.params;
  const provider = customProviderKey(slug);

  try {
    const { rows } = await pool.query(
      `SELECT * FROM integration_webhook_endpoints
       WHERE workspace_id = $1 AND provider = $2 AND active = true`,
      [workspaceId, provider]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Unknown webhook endpoint" });
    }

    // An endpoint may be registered per project or for the whole instance;
    // try each until one verifies.
    let endpoint = null;
    for (const candidate of rows) {
      const provided = req.headers[String(candidate.signature_header || "").toLowerCase()];
      if (!provided) continue;
      const verified = candidate.signature_scheme === "hmac_sha256"
        ? verifyHmac(candidate.secret, req.rawBody, provided)
        : timingSafeEqual(candidate.secret, provided);
      if (verified) { endpoint = candidate; break; }
    }

    if (!endpoint) {
      await pool.query(
        `UPDATE integration_webhook_endpoints
         SET rejected_count = rejected_count + 1, updated_at = NOW()
         WHERE workspace_id = $1 AND provider = $2`,
        [workspaceId, provider]
      ).catch(() => {});
      return res.status(403).json({ error: "Invalid webhook signature" });
    }

    // Respect the admin's project scope — an event for an excluded project
    // must not cause any work.
    const externalProjectId = endpoint.entity_id_path
      ? getPath(req.body, endpoint.entity_id_path)
      : (endpoint.external_project_id || null);

    const syncConfig = await getSyncConfig(workspaceId, provider);
    if (externalProjectId && !isProjectInScope(syncConfig, externalProjectId)) {
      return res.json({ received: true, skipped: "project_out_of_scope" });
    }

    await pool.query(
      `UPDATE integration_webhook_endpoints
       SET last_received_at = NOW(), received_count = received_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [endpoint.id]
    );
    await recordWebhookEvent({ workspaceId, provider }).catch(() => {});

    // Acknowledge immediately; the provider should not wait on our processing,
    // and a slow response is what causes platforms to disable a webhook.
    res.json({ received: true });
  } catch (error) {
    console.error("[custom-webhook] handler error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
