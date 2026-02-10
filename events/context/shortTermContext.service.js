import { upsertShortTermContext } from "./shortTermContext.store.js";

/**
 * Builds rolling 3-day context from events
 * This is deterministic, explainable logic (NOT LLM)
 */
export async function updateShortTermContext(event) {
  const { workspaceId, actorUserId, entityType, entityId, eventType } = event;

  // ---- USER CONTEXT ----
  if (actorUserId) {
    await upsertShortTermContext({
      workspaceId,
      subjectType: "user",
      subjectId: actorUserId,
      context: buildUserContext(event),
    });
  }

  // ---- ENTITY CONTEXT (task / project) ----
  if (entityType && entityId) {
    await upsertShortTermContext({
      workspaceId,
      subjectType: entityType,
      subjectId: entityId,
      context: buildEntityContext(event),
    });
  }
}

// ---------------- HELPERS ----------------

function buildUserContext(event) {
  return {
    lastEventType: event.eventType,
    lastActionAt: event.timestamp,
    recentActivity: true,
  };
}

function buildEntityContext(event) {
  return {
    lastEventType: event.eventType,
    lastUpdatedAt: event.timestamp,
    touchedBy: event.actorUserId,
  };
}
