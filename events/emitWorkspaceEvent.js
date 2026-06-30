import { publishEvent } from "./eventBus.js";
import { assertDomainEvent } from "../adaptive/events/domainEventContracts.js";
import { v4 as uuid } from "uuid";

/**
 * Stable event publication contract used by services and request observers.
 */
export async function emitWorkspaceEvent({
  workspaceId,
  actorUserId,
  eventType,
  entityType,
  entityId,
  origin = "internal",
  metadata = {},
  schemaVersion = 1,
  correlationId = null,
  causationId = null,
  traceId = null,
  timestamp = null,
}) {
  if (!workspaceId || !eventType || !entityType) {
    console.warn("[emitWorkspaceEvent] Missing required fields", {
      workspaceId,
      eventType,
      entityType,
    });
    return null;
  }

  const event = {
    eventId: uuid(),
    workspaceId,
    actorUserId: actorUserId && actorUserId !== "system" ? actorUserId : null,
    eventType,
    entityType,
    entityId: entityId || null,
    origin,
    schemaVersion: Math.max(1, Number(schemaVersion) || 1),
    correlationId,
    causationId,
    traceId,
    metadata,
    timestamp: timestamp || new Date().toISOString(),
  };
  assertDomainEvent(event, { allowUnknown: true });

  await publishEvent(event);
  return event;
}
