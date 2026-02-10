import pool from "../../db.js";

/**
 * Stores raw workspace events.
 * This is the ONLY place that writes to workspace_events.
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
  } = event;

  await pool.query(
    `
    INSERT INTO workspace_events
      (id, workspace_id, actor_user_id, event_type, entity_type, entity_id, metadata, created_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      eventId,
      workspaceId,
      actorUserId,
      eventType,
      entityType,
      entityId,
      metadata || {},
      timestamp,
    ]
  );
}
