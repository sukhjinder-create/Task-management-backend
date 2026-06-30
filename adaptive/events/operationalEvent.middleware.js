import crypto from "node:crypto";
import { emitWorkspaceEvent } from "../../events/emitWorkspaceEvent.js";
import { compactSummary, isUuid, redact, uuidOrNull } from "../shared/runtimeUtils.js";

const CAPTURE_ATTACHED = Symbol.for("asystence.adaptiveEventCapture");

const EVENT_RULES = [
  { method: "POST", pattern: /^\/projects\/?$/, eventType: "PROJECT_CREATED", entityType: "project" },
  { method: "DELETE", pattern: /^\/projects\/[^/]+\/?$/, eventType: "PROJECT_ARCHIVED", entityType: "project" },
  { methods: ["PUT", "PATCH"], pattern: /^\/projects\/[^/]+/, eventType: "PROJECT_UPDATED", entityType: "project" },
  { method: "POST", pattern: /^\/tasks(?:\/[0-9a-f-]{36})?\/?$/i, eventType: "TASK_CREATED", entityType: "task" },
  { method: "DELETE", pattern: /^\/tasks\/[^/]+\/?$/, eventType: "TASK_DELETED", entityType: "task" },
  { methods: ["PUT", "PATCH"], pattern: /^\/tasks\/[^/]+\/status/, eventType: "TASK_STATUS_CHANGED", entityType: "task" },
  { methods: ["PUT", "PATCH"], pattern: /^\/tasks\/[^/]+\/(assign|assignee)/, eventType: "TASK_ASSIGNED", entityType: "task" },
  { methods: ["PUT", "PATCH"], pattern: /^\/tasks\/[^/]+/, eventType: "TASK_UPDATED", entityType: "task" },
  { method: "POST", pattern: /^\/subtasks\/?$/, eventType: "SUBTASK_CREATED", entityType: "subtask" },
  { method: "DELETE", pattern: /^\/subtasks\/[^/]+/, eventType: "SUBTASK_DELETED", entityType: "subtask" },
  { methods: ["PUT", "PATCH"], pattern: /^\/subtasks\/[^/]+/, eventType: "SUBTASK_UPDATED", entityType: "subtask" },
  { method: "POST", pattern: /^\/(sprint|sprints)\/[^/]+\/start/, eventType: "SPRINT_STARTED", entityType: "sprint" },
  { method: "POST", pattern: /^\/(sprint|sprints)\/[^/]+\/(complete|close)/, eventType: "SPRINT_CLOSED", entityType: "sprint" },
  { methods: ["POST", "PATCH"], pattern: /^\/attendance/, eventType: "ATTENDANCE_CHANGED", entityType: "attendance" },
  { method: "PATCH", pattern: /^\/leave\/[^/]+\/approve/, eventType: "LEAVE_APPROVED", entityType: "leave" },
  { method: "PATCH", pattern: /^\/leave\/[^/]+\/reject/, eventType: "LEAVE_REJECTED", entityType: "leave" },
  { method: "POST", pattern: /^\/leave/, eventType: "LEAVE_REQUESTED", entityType: "leave" },
  { methods: ["POST", "PUT", "PATCH"], pattern: /^\/reviews/, eventType: "REVIEW_UPDATED", entityType: "review" },
  { methods: ["POST", "PUT", "PATCH"], pattern: /^\/(goals|okr)/, eventType: "GOAL_UPDATED", entityType: "goal" },
  { methods: ["POST", "PATCH"], pattern: /^\/huddle\/intelligence/, eventType: "MEETING_INTELLIGENCE_UPDATED", entityType: "meeting" },
  { method: "POST", pattern: /^\/huddle\/.*(start|sessions)/, eventType: "MEETING_STARTED", entityType: "meeting" },
  { methods: ["POST", "PATCH"], pattern: /^\/huddle\/.*(end|finalize)/, eventType: "MEETING_ENDED", entityType: "meeting" },
  { method: "POST", pattern: /^\/operations\/digests\/(generate|preview)/, eventType: "EXECUTIVE_SUMMARY_GENERATED", entityType: "executive_summary" },
  { methods: ["POST", "PATCH"], pattern: /^\/notifications\/.*(read|acknowledge)/, eventType: "NOTIFICATION_ACKNOWLEDGED", entityType: "notification" },
  { methods: ["POST", "PUT", "PATCH"], pattern: /^\/wiki/, eventType: "KNOWLEDGE_UPDATED", entityType: "knowledge" },
  { method: "POST", pattern: /^\/testing-agent\/.*\/run/, eventType: "TESTING_AGENT_RUN_REQUESTED", entityType: "testing_run" },
  { method: "POST", pattern: /^\/autopilot\/run/, eventType: "AUTOPILOT_RUN_REQUESTED", entityType: "autopilot" },
  { methods: ["POST", "PUT", "PATCH"], pattern: /^\/operations\/actions\//, eventType: "OPERATIONS_ACTION_DECIDED", entityType: "operations_action" },
];

function canonicalPath(originalUrl = "") {
  return String(originalUrl).split("?")[0].replace(/\/+$/, "") || "/";
}

function methodMatches(rule, method) {
  return rule.method === method || rule.methods?.includes(method);
}

function genericDescriptor(method, path) {
  const segments = path.split("/").filter(Boolean);
  const resource = String(segments[0] || "workspace")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  const verb = ({ POST: "CREATED", PUT: "UPDATED", PATCH: "UPDATED", DELETE: "DELETED" })[method] || "CHANGED";
  return {
    eventType: `${resource.toUpperCase()}_${verb}`,
    entityType: resource || "workspace",
  };
}

export function deriveEventDescriptor(method, originalUrl) {
  const normalizedMethod = String(method || "").toUpperCase();
  const path = canonicalPath(originalUrl).toLowerCase();
  const rule = EVENT_RULES.find((candidate) => methodMatches(candidate, normalizedMethod) && candidate.pattern.test(path));
  return rule
    ? { eventType: rule.eventType, entityType: rule.entityType }
    : genericDescriptor(normalizedMethod, path);
}

function findEntityId(req, responseBody, descriptor) {
  if (descriptor?.entityType === "meeting" && isUuid(req.params?.sessionId)) return req.params.sessionId;
  const candidates = [
    responseBody?.task?.id,
    responseBody?.project?.id,
    responseBody?.action?.id,
    responseBody?.data?.id,
    responseBody?.id,
    req.params?.id,
    req.params?.taskId,
    req.params?.projectId,
    req.params?.sessionId,
    req.params?.actionId,
    responseBody?.message?.id,
  ];
  return candidates.find(isUuid) || null;
}

export function attachOperationalEventCapture(req, res) {
  if (req[CAPTURE_ATTACHED]) return;
  req[CAPTURE_ATTACHED] = true;

  const method = String(req.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  if (!req.workspaceId || !req.user?.id) return;

  const startedAt = Date.now();
  const correlationId = isUuid(req.headers["x-correlation-id"])
    ? String(req.headers["x-correlation-id"])
    : crypto.randomUUID();
  const traceId = crypto.randomUUID();
  let responseBody = null;

  if (!res.headersSent) {
    res.setHeader("x-correlation-id", correlationId);
    res.setHeader("x-asystence-trace-id", traceId);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  res.once("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const descriptor = res.locals?.domainEvent || deriveEventDescriptor(method, req.originalUrl);
    const entityId = findEntityId(req, responseBody, descriptor);
    const metadata = {
      path: canonicalPath(req.originalUrl),
      method,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      actorRole: req.user?.role || null,
      request: compactSummary(redact(req.body || {})),
      response: compactSummary(redact(responseBody || {})),
      routeEntityId: entityId || null,
    };

    setImmediate(() => {
      emitWorkspaceEvent({
        workspaceId: req.workspaceId,
        actorUserId: uuidOrNull(req.user?.id),
        eventType: descriptor.eventType,
        entityType: descriptor.entityType,
        entityId,
        origin: "http",
        schemaVersion: 1,
        correlationId,
        traceId,
        metadata,
      }).catch((error) => {
        console.error("[adaptive-events] Request event capture failed:", error?.message || error);
      });
    });
  });
}
