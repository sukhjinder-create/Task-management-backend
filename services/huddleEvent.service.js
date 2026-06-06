import pool from "../db.js";

function runner(client) {
  return client || pool;
}

export async function createHuddleSessionEvent({
  sessionId = null,
  workspaceId,
  actorUserId = null,
  actorGuestId = null,
  eventType,
  eventPayload = {},
  client = null,
}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!eventType) throw new Error("eventType is required");

  const { rows } = await runner(client).query(
    `
    INSERT INTO huddle_session_events (
      session_id,
      workspace_id,
      actor_user_id,
      actor_guest_id,
      event_type,
      event_payload
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [
      sessionId,
      workspaceId,
      actorUserId,
      actorGuestId,
      eventType,
      JSON.stringify(eventPayload || {}),
    ]
  );

  return rows[0];
}

export async function logHuddleReconciliation({
  sessionId = null,
  workspaceId,
  actorUserId = null,
  reason,
  details = {},
  client = null,
}) {
  console.warn("[huddle:reconcile]", {
    sessionId,
    workspaceId,
    actorUserId,
    reason,
    ...details,
  });

  if (!workspaceId) return null;

  try {
    return await createHuddleSessionEvent({
      sessionId,
      workspaceId,
      actorUserId,
      eventType: "reconciliation.mismatch",
      eventPayload: { reason, ...details },
      client,
    });
  } catch (err) {
    console.warn("[huddle:reconcile:event_failed]", err.message);
    return null;
  }
}

export default {
  createHuddleSessionEvent,
  logHuddleReconciliation,
};
