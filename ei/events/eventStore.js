// ei/events/eventStore.js
//
// EI V2.1 §6/§7 — the immutable, append-only, per-workspace-sequenced event log
// (the substrate all later phases read/replay). Append is IDEMPOTENT (unique
// idempotency_key) and PER-WORKSPACE SEQUENCED under a transactional advisory lock
// so seq is strictly monotonic even under concurrency. Schema-tolerant: with no DB
// / un-migrated table, every function degrades to a no-op/empty (never throws).
//
// UNVERIFIED AT RUNTIME (requires a migrated database).
// Reuses the schema-tolerant read helper from the AI Platform studio DB layer.

import pool from "../../db.js";
import { q } from "../../ai-platform/studio/db.js";

/**
 * Append a canonical event. Returns the assigned seq, or null (duplicate / no DB).
 * @param {object} c canonical event (from canonicalEvent.fromDomainEvent)
 */
export async function appendEvent(c) {
  if (!c || !c.workspaceId || !c.idempotencyKey) return null;
  let client = null;
  try {
    client = await pool.connect();
  } catch {
    return null; // no DB reachable → no-op (schema-tolerant)
  }
  try {
    await client.query("BEGIN");
    // Serialize appends per workspace so seq is strictly monotonic (§7 ordering).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [c.workspaceId]);
    const { rows } = await client.query(
      `INSERT INTO ei_events
         (event_id, workspace_id, seq, type, schema_version, occurred_at, recorded_at,
          actor_type, actor_id, entities_json, trace_json, origin, source, idempotency_key, payload_json)
       SELECT $1, $2, COALESCE((SELECT MAX(seq) FROM ei_events WHERE workspace_id = $2), 0) + 1,
              $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING seq`,
      [
        c.eventId, c.workspaceId, c.type, c.schemaVersion, c.occurredAt,
        c.actor?.type ?? null, c.actor?.id ?? null,
        JSON.stringify(c.entities || []), JSON.stringify(c.trace || {}),
        c.origin || null, c.source || null, c.idempotencyKey, JSON.stringify(c.payload || {}),
      ]
    );
    await client.query("COMMIT");
    return rows[0]?.seq ?? null; // null → idempotent duplicate
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    console.warn("[ei] appendEvent skipped:", err.message);
    return null;
  } finally {
    client.release();
  }
}

/** Read events for a workspace after a sequence (for projection/replay). */
export async function readEvents({ workspaceId, sinceSeq = 0, limit = 500 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_events WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [workspaceId, Number(sinceSeq) || 0, Math.min(Number(limit) || 500, 2000)]
  );
  return rows;
}

/** Latest sequence for a workspace (0 if none / no DB). */
export async function latestSeq(workspaceId) {
  const { rows } = await q(`SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM ei_events WHERE workspace_id = $1`, [workspaceId]);
  return Number(rows?.[0]?.seq || 0);
}
