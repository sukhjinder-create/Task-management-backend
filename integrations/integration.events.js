import { publishEvent } from "../events/eventBus.js";
import { randomUUID } from "crypto";
import { resolveInternalEntityId } from "./externalEntity.repository.js";

/**
 * Emit integration event in native system format
 * while preserving stable identity mapping.
 */
export async function emitIntegrationEvent(type, payload) {

  // ✅ Resolve stable internal entity identity
  const internalEntityId = await resolveInternalEntityId({
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    externalId: payload.externalId,
    entityType: payload.entityType || "task",
  });

  const normalizedEvent = {
    // required by workspace_events table
    eventId: randomUUID(),

    workspaceId: payload.workspaceId,

    // external systems may not map to internal user yet
    actorUserId: null,

    eventType: type,
    entityType: payload.entityType || "task",

    // ✅ stable UUID (NO MORE random IDs)
    entityId: internalEntityId,

    metadata: payload,

    timestamp: new Date().toISOString(),
  };

  await publishEvent(normalizedEvent);
}
