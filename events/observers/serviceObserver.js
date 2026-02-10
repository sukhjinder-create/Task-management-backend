import { emitWorkspaceEvent } from "../emitWorkspaceEvent.js";
import { EVENT_TYPES } from "../eventTypes.js";

/**
 * Wraps a service object and observes all method calls
 * WITHOUT modifying the service code itself
 */
export function observeService(service, entityType) {
  return new Proxy(service, {
    get(target, prop) {
      const original = target[prop];

      if (typeof original !== "function") {
        return original;
      }

      return async function (...args) {
        const result = await original.apply(target, args);

        // Heuristic-based event inference
        inferAndEmitEvent({
          entityType,
          methodName: prop,
          args,
          result,
        });

        return result;
      };
    },
  });
}

async function inferAndEmitEvent({ entityType, methodName, args, result }) {
  // Minimal, safe inference (expand later)

  if (!result) return;

  const workspaceId =
    args?.[0]?.workspaceId ||
    args?.[1]?.workspaceId ||
    result.workspace_id ||
    result.workspaceId;

  if (!workspaceId) return;

  let eventType = null;

  if (methodName.includes("create")) {
    eventType =
      entityType === "project"
        ? EVENT_TYPES.PROJECT_CREATED
        : EVENT_TYPES.TASK_CREATED;
  }

  if (methodName.includes("update")) {
    eventType =
      entityType === "project"
        ? EVENT_TYPES.PROJECT_UPDATED
        : EVENT_TYPES.TASK_UPDATED;
  }

  if (methodName.includes("delete")) {
    eventType =
      entityType === "project"
        ? EVENT_TYPES.PROJECT_ARCHIVED
        : EVENT_TYPES.TASK_DELETED;
  }

  if (!eventType) return;

  await emitWorkspaceEvent({
    workspaceId,
    actorUserId: "system",
    eventType,
    entityType,
    entityId: result.id,
    metadata: {
      method: methodName,
    },
  });
}
