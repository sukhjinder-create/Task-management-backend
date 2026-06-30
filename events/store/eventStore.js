import pool from "../../db.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value) {
  return UUID_PATTERN.test(String(value || "")) ? value : null;
}

/**
 * Append one immutable, versioned workspace event. This is the only writer for
 * workspace_events; duplicate event ids are safe during retries and replay.
 */
export async function storeWorkspaceEvent(event) {
  const {
    eventId,
    workspaceId,
    actorUserId,
    eventType,
    entityType,
    entityId,
    metadata,
    timestamp,
    schemaVersion = 1,
    origin = "internal",
    correlationId = null,
    causationId = null,
    traceId = null,
  } = event;

  const normalizedMetadata = {
    ...(metadata || {}),
    ...(entityId && !uuidOrNull(entityId) ? { sourceEntityId: String(entityId) } : {}),
  };
  const params = [
    eventId,
    workspaceId,
    uuidOrNull(actorUserId),
    eventType,
    entityType,
    uuidOrNull(entityId),
    normalizedMetadata,
    timestamp,
    Math.max(1, Number(schemaVersion) || 1),
    origin || "internal",
    uuidOrNull(correlationId),
    uuidOrNull(causationId),
    uuidOrNull(traceId),
  ];

  let rows;
  try {
    ({ rows } = await pool.query(
      `
      INSERT INTO workspace_events
        (id, workspace_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at,
         schema_version, origin, correlation_id, causation_id, trace_id, occurred_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $8)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
      `,
      params
    ));
  } catch (error) {
    if (error?.code !== "42703") throw error;
    ({ rows } = await pool.query(
      `
      INSERT INTO workspace_events
        (id, workspace_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
      `,
      params.slice(0, 8)
    ));
  }

  return rows[0] || null;
}
