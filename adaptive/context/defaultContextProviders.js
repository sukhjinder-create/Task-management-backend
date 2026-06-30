import projectService from "../../services/project.service.js";
import { getTaskById } from "../../services/task.service.js";
import { listWorkspaceMemoryEntries } from "../../services/workspaceMemory.service.js";
import { getWorkspaceIntelligence } from "../../intelligence/repositories/unifiedIntelligence.repository.js";
import { getOperationsCommandCenter } from "../../services/operationsCommandCenter.service.js";
import { registerContextProvider } from "./contextRegistry.js";
import { isUuid } from "../shared/runtimeUtils.js";
import { buildOperationalContextGraph } from "./operationalContextGraph.service.js";

export function registerDefaultContextProviders() {
  registerContextProvider({
    key: "operationalGraph",
    description: "Relevant tenant-scoped delivery, people, meeting, knowledge, outcome and policy graph",
    priority: 85,
    timeoutMs: 5000,
    load: buildOperationalContextGraph,
  });

  registerContextProvider({
    key: "event",
    description: "Versioned operational event and permission context",
    priority: 100,
    load: ({ event }) => ({
      id: event.eventId,
      type: event.eventType,
      schemaVersion: event.schemaVersion,
      entityType: event.entityType,
      entityId: event.entityId,
      occurredAt: event.timestamp,
      actorUserId: event.actorUserId,
      actorRole: event.metadata?.actorRole || null,
      origin: event.origin,
      metadata: event.metadata || {},
    }),
  });

  registerContextProvider({
    key: "task",
    description: "Current task state loaded through task service",
    priority: 90,
    supports: ({ event }) => event.entityType === "task" && isUuid(event.entityId),
    load: ({ event }) => getTaskById(event.entityId, event.workspaceId),
  });

  registerContextProvider({
    key: "project",
    description: "Current project state loaded through project service",
    priority: 80,
    supports: ({ event }) => event.entityType === "project" && isUuid(event.entityId),
    load: ({ event }) => projectService.getOne(event.entityId, event.workspaceId),
  });

  registerContextProvider({
    key: "workspaceIntelligence",
    description: "Canonical enterprise workspace intelligence",
    priority: 70,
    load: ({ event }) => getWorkspaceIntelligence({ workspaceId: event.workspaceId }),
  });

  registerContextProvider({
    key: "workspaceMemory",
    description: "Existing scoped workspace memory",
    priority: 40,
    load: ({ event, settings }) => listWorkspaceMemoryEntries({
      workspaceId: event.workspaceId,
      userId: isUuid(event.actorUserId) ? event.actorUserId : null,
      role: event.metadata?.actorRole || "user",
      limit: Math.min(Math.max(Number(settings?.context_limits?.memoryEntries) || 10, 1), 25),
    }),
  });

  registerContextProvider({
    key: "commandCenter",
    description: "Existing role-aware Operations OS context",
    priority: 30,
    supports: ({ event }) => [
      "ATTENDANCE_CHANGED",
      "LEAVE_APPROVED",
      "LEAVE_REJECTED",
      "WORKSPACE_SCORE_CHANGED",
      "MEETING_INTELLIGENCE_UPDATED",
    ].includes(event.eventType) && isUuid(event.actorUserId),
    load: ({ event }) => getOperationsCommandCenter({
      workspaceId: event.workspaceId,
      userId: event.actorUserId,
      role: event.metadata?.actorRole || "user",
    }),
  });
}
