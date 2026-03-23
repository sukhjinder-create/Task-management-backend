// services/webhook.service.js
// Outbound webhook delivery to external URLs
import crypto from "crypto";
import axios from "axios";
import db from "../db.js";

/**
 * Fire all matching webhooks for an event in a workspace.
 * Non-blocking — runs in the background.
 */
export function fireWebhooks(workspaceId, event, payload) {
  // Run async without blocking caller
  _deliver(workspaceId, event, payload).catch(err =>
    console.warn("[webhooks] delivery error:", err.message)
  );
}

async function _deliver(workspaceId, event, payload) {
  const rows = await db.query(
    "SELECT * FROM webhooks WHERE workspace_id = $1 AND is_active = true AND $2 = ANY(events)",
    [workspaceId, event]
  );

  for (const hook of rows.rows) {
    const start = Date.now();
    let responseStatus = null;
    let responseBody = null;
    let success = false;

    try {
      const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
      const headers = {
        "Content-Type": "application/json",
        "X-TaskManagement-Event": event,
        "X-TaskManagement-Delivery": crypto.randomUUID(),
      };

      // Add HMAC signature when secret configured
      if (hook.secret) {
        headers["X-TaskManagement-Signature"] = "sha256=" +
          crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
      }

      const response = await axios.post(hook.url, body, {
        headers,
        timeout: 10000,
        validateStatus: () => true, // don't throw on 4xx/5xx
      });

      responseStatus = response.status;
      responseBody   = typeof response.data === "string" ? response.data.slice(0, 1000) : JSON.stringify(response.data).slice(0, 1000);
      success        = response.status >= 200 && response.status < 300;
    } catch (err) {
      responseBody = err.message;
    }

    const duration = Date.now() - start;

    // Log delivery
    await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event, payload, response_status, response_body, duration_ms, success)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [hook.id, event, JSON.stringify(payload), responseStatus, responseBody, duration, success]
    ).catch(() => {});

    // Update failure count and last_fired_at
    await db.query(
      `UPDATE webhooks SET
         last_fired_at = NOW(),
         failure_count = CASE WHEN $1 THEN 0 ELSE failure_count + 1 END,
         is_active     = CASE WHEN failure_count >= 9 AND NOT $1 THEN false ELSE is_active END
       WHERE id = $2`,
      [success, hook.id]
    ).catch(() => {});
  }
}

/**
 * Test a webhook by sending a ping event.
 */
export async function testWebhook(webhookId, workspaceId) {
  const row = await db.query(
    "SELECT * FROM webhooks WHERE id = $1 AND workspace_id = $2",
    [webhookId, workspaceId]
  );
  if (!row.rows[0]) throw new Error("Webhook not found");
  await _deliver(workspaceId, "ping", { message: "Test delivery from TaskManagement" });
  return { sent: true };
}
