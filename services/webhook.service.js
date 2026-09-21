import crypto from "node:crypto";
import db from "../db.js";
import { safeFetchJson } from "../integrations/core/safeFetch.js";
import { decryptSecret } from "../config/dataEncryption.js";

const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000];
let workerTimer = null;

function deliveryEnvelope(delivery) {
  return JSON.stringify({
    event: delivery.event,
    payload: delivery.payload,
    timestamp: new Date(delivery.created_at).toISOString(),
  });
}

async function sendClaimedDelivery(delivery, database = db) {
  const startedAt = Date.now();
  const body = deliveryEnvelope(delivery);
  const headers = {
    "Content-Type": "application/json",
    "X-Asystence-Event": delivery.event,
    "X-Asystence-Delivery": delivery.delivery_id,
    // Keep the previous headers while consumers migrate to the product name.
    "X-TaskManagement-Event": delivery.event,
    "X-TaskManagement-Delivery": delivery.delivery_id,
  };
  if (delivery.secret) {
    const signature = `sha256=${crypto.createHmac("sha256", decryptSecret(delivery.secret)).update(body).digest("hex")}`;
    headers["X-Asystence-Signature"] = signature;
    headers["X-TaskManagement-Signature"] = signature;
  }

  let statusCode = null;
  let responseBody = null;
  let errorMessage = null;
  let success = false;
  try {
    const response = await safeFetchJson(delivery.url, {
      method: "POST",
      headers,
      body,
      timeoutMs: 10_000,
    });
    statusCode = response.status;
    responseBody = response.rawPreview?.slice(0, 1000) || null;
    success = response.ok;
    if (!success) errorMessage = `HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error.message;
    responseBody = error.message.slice(0, 1000);
  }

  const attempts = Number(delivery.attempt_count || 1);
  const terminal = !success && attempts >= MAX_ATTEMPTS;
  const retryDelay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
  await database.query(
    `UPDATE webhook_deliveries
        SET response_status = $2,
            response_body = $3,
            duration_ms = $4,
            success = $5,
            status = $6,
            last_error = $7,
            completed_at = CASE WHEN $5 OR $6 = 'dead' THEN now() ELSE NULL END,
            next_attempt_at = CASE WHEN $6 = 'pending' THEN now() + ($8 * interval '1 millisecond') ELSE next_attempt_at END,
            locked_at = NULL
      WHERE id = $1`,
    [
      delivery.id,
      statusCode,
      responseBody,
      Date.now() - startedAt,
      success,
      success ? "delivered" : terminal ? "dead" : "pending",
      errorMessage,
      retryDelay,
    ]
  );

  await database.query(
    `UPDATE webhooks
        SET last_fired_at = now(),
            failure_count = CASE WHEN $1 THEN 0 ELSE failure_count + 1 END
      WHERE id = $2 AND workspace_id = $3`,
    [success, delivery.webhook_id, delivery.workspace_id]
  );

  return { sent: true, success, status: statusCode, deliveryId: delivery.delivery_id };
}

async function claimDeliveries({ limit = 25, deliveryId = null, database = db } = {}) {
  const result = await database.query(
    `WITH candidates AS (
       SELECT delivery.id
         FROM webhook_deliveries delivery
         JOIN webhooks webhook
           ON webhook.id = delivery.webhook_id
          AND webhook.workspace_id = delivery.workspace_id
        WHERE webhook.is_active = true
          AND ($2::uuid IS NULL OR delivery.id = $2::uuid)
          AND (
            (delivery.status = 'pending' AND delivery.next_attempt_at <= now())
            OR (delivery.status = 'processing' AND delivery.locked_at < now() - interval '5 minutes')
          )
        ORDER BY delivery.next_attempt_at, delivery.created_at
        LIMIT $1
        FOR UPDATE OF delivery SKIP LOCKED
     ), claimed AS (
       UPDATE webhook_deliveries delivery
          SET status = 'processing', locked_at = now(), attempt_count = attempt_count + 1
         FROM candidates
        WHERE delivery.id = candidates.id
        RETURNING delivery.*
     )
     SELECT claimed.*, webhook.url, webhook.secret
       FROM claimed
       JOIN webhooks webhook
         ON webhook.id = claimed.webhook_id
        AND webhook.workspace_id = claimed.workspace_id`,
    [Math.min(Math.max(Number(limit) || 25, 1), 100), deliveryId]
  );
  return result.rows;
}

export async function processWebhookQueue(options = {}) {
  const deliveries = await claimDeliveries(options);
  const results = [];
  for (const delivery of deliveries) {
    results.push(await sendClaimedDelivery(delivery, options.database || db));
  }
  return results;
}

export async function enqueueWebhookDeliveries(workspaceId, event, payload, database = db) {
  const result = await database.query(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event, payload)
     SELECT workspace_id, id, $2, $3::jsonb
       FROM webhooks
      WHERE workspace_id = $1 AND is_active = true AND $2 = ANY(events)
     RETURNING id, delivery_id`,
    [workspaceId, event, JSON.stringify(payload ?? {})]
  );
  return result.rows;
}

/** Queue first, then attempt immediately. Callers may await the returned promise. */
export function fireWebhooks(workspaceId, event, payload) {
  return enqueueWebhookDeliveries(workspaceId, event, payload)
    .then(() => processWebhookQueue())
    .catch((error) => console.warn("[webhooks] enqueue/delivery error:", error.message));
}

export async function testWebhook(webhookId, workspaceId, database = db) {
  const inserted = await database.query(
    `INSERT INTO webhook_deliveries (workspace_id, webhook_id, event, payload)
     SELECT workspace_id, id, 'ping', $3::jsonb
       FROM webhooks
      WHERE id = $1 AND workspace_id = $2 AND is_active = true
     RETURNING id`,
    [webhookId, workspaceId, JSON.stringify({ message: "Test delivery from Asystence" })]
  );
  if (!inserted.rows[0]) throw new Error("Webhook not found or inactive");
  const [result] = await processWebhookQueue({ deliveryId: inserted.rows[0].id, database });
  return result || { sent: false };
}

export async function replayWebhookDelivery(deliveryId, workspaceId, database = db) {
  const reset = await database.query(
    `UPDATE webhook_deliveries delivery
        SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
            locked_at = NULL, completed_at = NULL, last_error = NULL,
            response_status = NULL, response_body = NULL, success = false
       FROM webhooks webhook
      WHERE delivery.id = $1
        AND delivery.webhook_id = webhook.id
        AND delivery.workspace_id = webhook.workspace_id
        AND delivery.workspace_id = $2
      RETURNING delivery.id`,
    [deliveryId, workspaceId]
  );
  if (!reset.rows[0]) throw new Error("Webhook delivery not found");
  const [result] = await processWebhookQueue({ deliveryId: reset.rows[0].id, database });
  return result || { sent: false };
}

export function startWebhookDeliveryWorker({ intervalMs = 15_000 } = {}) {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => {
    processWebhookQueue().catch((error) => console.warn("[webhooks] worker error:", error.message));
  }, Math.max(intervalMs, 5_000));
  workerTimer.unref?.();
  return workerTimer;
}

export function stopWebhookDeliveryWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export const __testables = { deliveryEnvelope, claimDeliveries, sendClaimedDelivery, MAX_ATTEMPTS };
