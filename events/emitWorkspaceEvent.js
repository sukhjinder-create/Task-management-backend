import { publishEvent } from "./eventBus.js";
import { v4 as uuid } from "uuid";

/**
 * This is the ONLY function services will ever call.
 * Services do not know about observers or AI.
 */
export async function emitWorkspaceEvent({
  workspaceId,
  actorUserId,
  eventType,
  entityType,
  entityId,
  metadata = {},
}) {
  if (!workspaceId || !eventType || !entityType) {
    console.warn("[emitWorkspaceEvent] Missing required fields", {
      workspaceId,
      eventType,
      entityType,
    });
    return;
  }

  const event = {
    eventId: uuid(),
    workspaceId,
    actorUserId: actorUserId || "system",
    eventType,
    entityType,
    entityId: entityId || null,
    metadata,
    timestamp: new Date().toISOString(),
  };

  await publishEvent(event);
}
