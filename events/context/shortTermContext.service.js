import { upsertShortTermContext } from "./shortTermContext.store.js";

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

/** Builds deterministic rolling context from persisted events. */
export async function updateShortTermContext(event) {
  const { workspaceId, actorUserId, entityType, entityId } = event;

  if (isUuid(actorUserId)) {
    await upsertShortTermContext({
      workspaceId,
      subjectType: "user",
      subjectId: actorUserId,
      context: {
        lastEventType: event.eventType,
        lastActionAt: event.timestamp,
        recentActivity: true,
      },
    });
  }

  if (entityType && isUuid(entityId)) {
    await upsertShortTermContext({
      workspaceId,
      subjectType: entityType,
      subjectId: entityId,
      context: {
        lastEventType: event.eventType,
        lastUpdatedAt: event.timestamp,
        touchedBy: isUuid(actorUserId) ? actorUserId : null,
      },
    });
  }
}
