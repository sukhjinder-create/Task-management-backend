import pool from "../../db.js";
import { getRuntimeSettings } from "../config/runtimeSettings.service.js";

export async function enqueueAdaptiveEvent(event) {
  if (!event?.eventId || !event?.workspaceId) return null;
  if (String(event.eventType || "").startsWith("ADAPTIVE_")) return null;

  const settings = await getRuntimeSettings(event.workspaceId);
  if (!settings.event_capture_enabled || settings.mode === "off") return null;

  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_event_queue (workspace_id, event_id)
    VALUES ($1, $2)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING *
    `,
    [event.workspaceId, event.eventId]
  );
  return rows[0] || null;
}

export async function claimAdaptiveEvents({ workerId, limit = 10, leaseSeconds = 120 }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
      WITH candidates AS (
        SELECT id
        FROM adaptive_event_queue
        WHERE (
          status = 'pending'
          OR (status = 'processing' AND lease_expires_at < NOW())
        )
          AND available_at <= NOW()
          AND attempts < max_attempts
        ORDER BY available_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE adaptive_event_queue q
      SET status = 'processing',
          locked_at = NOW(),
          locked_by = $2,
          lease_expires_at = NOW() + ($3::text || ' seconds')::interval,
          attempts = attempts + 1
      FROM candidates c
      WHERE q.id = c.id
      RETURNING q.*
      `,
      [Math.min(Math.max(Number(limit) || 10, 1), 50), workerId, String(leaseSeconds)]
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error?.code === "42P01") return [];
    throw error;
  } finally {
    client.release();
  }
}

export async function loadQueuedEvent(queueItem) {
  const { rows } = await pool.query(
    `
    SELECT
      id AS "eventId",
      workspace_id AS "workspaceId",
      actor_user_id AS "actorUserId",
      event_type AS "eventType",
      entity_type AS "entityType",
      entity_id AS "entityId",
      metadata,
      schema_version AS "schemaVersion",
      origin,
      correlation_id AS "correlationId",
      causation_id AS "causationId",
      trace_id AS "traceId",
      COALESCE(occurred_at, created_at) AS timestamp
    FROM workspace_events
    WHERE id = $1 AND workspace_id = $2
    LIMIT 1
    `,
    [queueItem.event_id, queueItem.workspace_id]
  );
  return rows[0] || null;
}

export async function completeAdaptiveEvent(queueId) {
  await pool.query(
    `UPDATE adaptive_event_queue
     SET status = 'completed', processed_at = NOW(), lease_expires_at = NULL, locked_by = NULL
     WHERE id = $1`,
    [queueId]
  );
}

export async function failAdaptiveEvent(queueItem, error) {
  const terminal = Number(queueItem.attempts) >= Number(queueItem.max_attempts);
  const backoffSeconds = Math.min(300, 2 ** Math.max(1, Number(queueItem.attempts)));
  await pool.query(
    `UPDATE adaptive_event_queue
     SET status = $1,
         last_error = $2,
         available_at = CASE WHEN $1 = 'pending'
           THEN NOW() + ($3::text || ' seconds')::interval ELSE available_at END,
         lease_expires_at = NULL,
         locked_by = NULL
     WHERE id = $4`,
    [terminal ? "failed" : "pending", String(error?.message || error).slice(0, 2000), String(backoffSeconds), queueItem.id]
  );
}

export async function replayWorkspaceEvents({ workspaceId, eventIds = [], since = null, limit = 100 }) {
  const params = [workspaceId];
  const where = ["workspace_id = $1"];
  let index = 2;
  if (eventIds.length) {
    where.push(`id = ANY($${index++}::uuid[])`);
    params.push(eventIds);
  }
  if (since) {
    where.push(`COALESCE(occurred_at, created_at) >= $${index++}`);
    params.push(since);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));

  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_event_queue (workspace_id, event_id)
    SELECT workspace_id, id
    FROM workspace_events
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(occurred_at, created_at) ASC
    LIMIT $${index}
    ON CONFLICT (event_id) DO UPDATE SET
      status = 'pending', available_at = NOW(), attempts = 0,
      processed_at = NULL, last_error = NULL
    RETURNING event_id
    `,
    params
  );
  return { queued: rows.length, eventIds: rows.map((row) => row.event_id) };
}
