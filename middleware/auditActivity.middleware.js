import { logAudit } from "../services/audit.service.js";

// ─── Sensitive field redaction ────────────────────────────────────────────────

const SENSITIVE_KEYS = [
  "password", "token", "secret", "authorization", "api_key", "apikey",
  "access_token", "refresh_token", "client_secret", "code", "otp", "pin",
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function redactValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).slice(0, 40).map(([k, v]) => {
        if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) return [k, "[redacted]"];
        return [k, redactValue(v, depth + 1)];
      })
    );
  }
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return value;
}

function summarizeFiles(req) {
  const toEntry = (f) => ({ field: f.fieldname, name: f.originalname, size: f.size, type: f.mimetype });
  if (Array.isArray(req.files)) return req.files.map(toEntry);
  if (req.files && isPlainObject(req.files)) {
    return Object.fromEntries(Object.entries(req.files).map(([k, files]) => [k, files.map(toEntry)]));
  }
  if (req.file) return [toEntry(req.file)];
  return null;
}

// ─── Semantic action derivation ───────────────────────────────────────────────

/**
 * Maps HTTP method + URL pattern to a human-readable audit action name.
 * Format: "<resource>.<verb>"   e.g. "review_cycle.create"
 *
 * Rules (applied in order):
 *  1. Explicit route override table — highest precision
 *  2. Special sub-route suffix → overrides verb
 *  3. HTTP method → default verb (create / update / delete)
 *  4. Resource name from URL segments
 */

// Exact-match overrides. Key = "METHOD /normalised/path"
// Normalised path: UUIDs and integers replaced with :id
const ROUTE_OVERRIDES = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  "POST /auth/login":                        "auth.login",
  "POST /auth/logout":                       "auth.logout",
  "POST /auth/register":                     "auth.register",
  "POST /auth/refresh":                      "auth.token_refresh",
  "POST /auth/forgot-password":              "auth.password_reset_request",
  "POST /auth/reset-password":               "auth.password_reset",
  "POST /auth/verify-email":                 "auth.email_verify",
  "POST /auth/magic-link":                   "auth.magic_link",
  // ── Users ─────────────────────────────────────────────────────────────────
  "POST /users/invite":                      "user.invite",
  "DELETE /users/:id":                       "user.remove",
  "PATCH /users/:id/role":                   "user.role_change",
  "PATCH /users/:id/profile":                "user.profile_update",
  "PATCH /users/:id/status":                 "user.status_change",
  "POST /users/:id/resend-invite":           "user.invite_resend",
  // ── Workspace ─────────────────────────────────────────────────────────────
  "PATCH /workspace":                        "workspace.update",
  "PATCH /workspace/settings":              "workspace.settings_update",
  "DELETE /workspace":                       "workspace.delete",
  "POST /workspace/transfer":               "workspace.ownership_transfer",
  // ── Projects ──────────────────────────────────────────────────────────────
  "POST /projects":                          "project.create",
  "PUT /projects/:id":                       "project.update",
  "PATCH /projects/:id":                     "project.update",
  "DELETE /projects/:id":                    "project.delete",
  "POST /projects/:id/members":             "project.member_add",
  "DELETE /projects/:id/members/:id":       "project.member_remove",
  "PATCH /projects/:id/archive":            "project.archive",
  "PATCH /projects/:id/restore":            "project.restore",
  "PATCH /projects/:id/status":             "project.status_change",
  // ── Tasks ─────────────────────────────────────────────────────────────────
  "POST /tasks":                             "task.create",
  "PUT /tasks/:id":                          "task.update",
  "PATCH /tasks/:id":                        "task.update",
  "DELETE /tasks/:id":                       "task.delete",
  "PATCH /tasks/:id/status":                "task.status_change",
  "PATCH /tasks/:id/assign":                "task.assign",
  "PATCH /tasks/:id/priority":              "task.priority_change",
  "POST /tasks/:id/attachments":            "task.attachment_upload",
  "DELETE /tasks/:id/attachments/:id":      "task.attachment_delete",
  // ── Subtasks ──────────────────────────────────────────────────────────────
  "POST /subtasks":                          "subtask.create",
  "PUT /subtasks/:id":                       "subtask.update",
  "PATCH /subtasks/:id":                     "subtask.update",
  "DELETE /subtasks/:id":                    "subtask.delete",
  // ── Sprints ───────────────────────────────────────────────────────────────
  "POST /sprint":                            "sprint.create",
  "PUT /sprint/:id":                         "sprint.update",
  "PATCH /sprint/:id":                       "sprint.update",
  "DELETE /sprint/:id":                      "sprint.delete",
  "PATCH /sprint/:id/status":               "sprint.status_change",
  "POST /sprint/:id/complete":              "sprint.complete",
  "POST /sprint/:id/start":                 "sprint.start",
  // ── Reviews ───────────────────────────────────────────────────────────────
  "POST /reviews/cycles":                    "review_cycle.create",
  "PATCH /reviews/cycles/:id/status":        "review_cycle.status_change",
  "POST /reviews/trigger-quarter":           "review_cycle.trigger_quarter",
  "POST /reviews/cycles/:id/reviews":        "review.create",
  "PUT /reviews/reviews/:id":               "review.submit",
  "PATCH /reviews/team/bulk-manager":        "review_team.bulk_manager_assign",
  "PATCH /reviews/team/:id/manager":         "review_team.manager_assign",
  // ── Wiki / Docs ───────────────────────────────────────────────────────────
  "POST /wiki":                              "wiki.create",
  "PUT /wiki/:id":                           "wiki.update",
  "PATCH /wiki/:id":                         "wiki.update",
  "DELETE /wiki/:id":                        "wiki.delete",
  "POST /wiki/:id/publish":                 "wiki.publish",
  "POST /wiki/:id/archive":                 "wiki.archive",
  // ── Goals / OKRs ──────────────────────────────────────────────────────────
  "POST /goals":                             "goal.create",
  "PUT /goals/:id":                          "goal.update",
  "PATCH /goals/:id":                        "goal.update",
  "DELETE /goals/:id":                       "goal.delete",
  "POST /okr":                               "okr.create",
  "PUT /okr/:id":                            "okr.update",
  "PATCH /okr/:id":                          "okr.update",
  "DELETE /okr/:id":                         "okr.delete",
  // ── Leave ─────────────────────────────────────────────────────────────────
  "POST /leave":                             "leave.request",
  "PATCH /leave/:id/approve":               "leave.approve",
  "PATCH /leave/:id/reject":                "leave.reject",
  "PATCH /leave/:id/cancel":                "leave.cancel",
  "DELETE /leave/:id":                       "leave.delete",
  "POST /leave/balance":                    "leave.balance_update",
  // ── Attendance ────────────────────────────────────────────────────────────
  "POST /attendance":                        "attendance.log",
  "PATCH /attendance/:id":                   "attendance.edit",
  "DELETE /attendance/:id":                  "attendance.delete",
  "POST /attendance/admin/recalculate":     "attendance.recalculate",
  "POST /admin/attendance/recalculate":     "attendance.recalculate",
  // ── Webhooks / API Keys ───────────────────────────────────────────────────
  "POST /webhooks":                          "webhook.create",
  "PUT /webhooks/:id":                       "webhook.update",
  "PATCH /webhooks/:id":                     "webhook.update",
  "DELETE /webhooks/:id":                    "webhook.delete",
  "POST /api-keys":                          "api_key.create",
  "DELETE /api-keys/:id":                    "api_key.revoke",
  "PATCH /api-keys/:id":                     "api_key.update",
  // ── Integrations ─────────────────────────────────────────────────────────
  "POST /integrations":                      "integration.connect",
  "DELETE /integrations/:id":               "integration.disconnect",
  "PATCH /integrations/:id":                "integration.update",
  // ── Comments ─────────────────────────────────────────────────────────────
  "POST /comments":                          "comment.create",
  "PUT /comments/:id":                       "comment.update",
  "PATCH /comments/:id":                     "comment.update",
  "DELETE /comments/:id":                    "comment.delete",
  // ── Tags ─────────────────────────────────────────────────────────────────
  "POST /tags":                              "tag.create",
  "PUT /tags/:id":                           "tag.update",
  "PATCH /tags/:id":                         "tag.update",
  "DELETE /tags/:id":                        "tag.delete",
  // ── Reports ───────────────────────────────────────────────────────────────
  "POST /report":                            "report.generate",
  "DELETE /report/:id":                      "report.delete",
  // ── Uploads ───────────────────────────────────────────────────────────────
  "POST /upload":                            "file.upload",
  "DELETE /upload/:id":                      "file.delete",
  // ── GDPR ─────────────────────────────────────────────────────────────────
  "POST /gdpr/export":                       "gdpr.export_request",
  "POST /gdpr/delete":                       "gdpr.delete_request",
  // ── Backup ───────────────────────────────────────────────────────────────
  "POST /backup":                            "backup.trigger",
  // ── AI / Autopilot ───────────────────────────────────────────────────────
  "POST /autopilot":                         "autopilot.action",
  "PATCH /autopilot/:id":                    "autopilot.update",
  "POST /ai-features":                       "ai.action",
};

// Sub-route suffix → verb override (applied when no explicit override matches)
const SUFFIX_VERBS = {
  "/login":            "login",
  "/logout":           "logout",
  "/register":         "register",
  "/invite":           "invite",
  "/status":           "status_change",
  "/activate":         "activate",
  "/deactivate":       "deactivate",
  "/archive":          "archive",
  "/restore":          "restore",
  "/complete":         "complete",
  "/start":            "start",
  "/cancel":           "cancel",
  "/approve":          "approve",
  "/reject":           "reject",
  "/publish":          "publish",
  "/submit":           "submit",
  "/assign":           "assign",
  "/unassign":         "unassign",
  "/transfer":         "transfer",
  "/resend":           "resend",
  "/revoke":           "revoke",
  "/reset-password":   "password_reset",
  "/change-password":  "password_change",
  "/role":             "role_change",
  "/permissions":      "permission_change",
  "/priority":         "priority_change",
  "/manager":          "manager_assign",
  "/bulk-manager":     "bulk_manager_assign",
  "/trigger-quarter":  "trigger_quarter",
  "/recalculate":      "recalculate",
  "/export":           "export",
  "/import":           "import",
};

// Resource name overrides for first/second path segment combinations
const RESOURCE_MAP = {
  "reviews/cycles":          "review_cycle",
  "reviews/reviews":         "review",
  "reviews/team":            "review_team",
  "reviews/trigger-quarter": "review_cycle",
  "reviews/user-context":    "review",
  "auth":                    "auth",
  "users":                   "user",
  "workspace":               "workspace",
  "workspaces":              "workspace",
  "projects":                "project",
  "tasks":                   "task",
  "subtasks":                "subtask",
  "sprint":                  "sprint",
  "wiki":                    "wiki",
  "goals":                   "goal",
  "okr":                     "okr",
  "leave":                   "leave",
  "attendance":              "attendance",
  "webhooks":                "webhook",
  "api-keys":                "api_key",
  "integrations":            "integration",
  "comments":                "comment",
  "tags":                    "tag",
  "report":                  "report",
  "upload":                  "file",
  "gdpr":                    "gdpr",
  "backup":                  "backup",
  "autopilot":               "autopilot",
  "ai-features":             "ai",
  "chat":                    "chat",
  "chat-channels":           "chat_channel",
  "notifications":           "notification",
  "holidays":                "holiday",
  "settings-attendance":     "attendance_settings",
  "time-tracking":           "time_entry",
  "task-links":              "task_link",
  "watchers":                "watcher",
  "votes":                   "vote",
  "saved-filters":           "saved_filter",
  "issue-templates":         "issue_template",
};

function normaliseUUIDs(path) {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d{4,}/g, "/:id"); // long numeric IDs
}

function deriveSemanticAction(method, baseUrl, path) {
  // Full path (normalise to lowercase, collapse double slashes)
  const full = `${baseUrl}${path}`.replace(/\/+/g, "/").toLowerCase();
  const normalised = normaliseUUIDs(full);

  // 1. Explicit override
  const key = `${method} ${normalised}`;
  if (ROUTE_OVERRIDES[key]) return ROUTE_OVERRIDES[key];

  // 2. Derive from heuristics
  const segments = normalised.split("/").filter((s) => s && s !== ":id");

  // Determine verb
  const methodVerb = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" }[method] || "action";

  // Check for special suffix override
  let verb = methodVerb;
  for (const [suffix, specialVerb] of Object.entries(SUFFIX_VERBS)) {
    if (normalised.endsWith(suffix)) {
      verb = specialVerb;
      break;
    }
  }

  // Determine resource
  const twoSegment = segments.slice(0, 2).join("/");
  const oneSegment = segments[0] || "workspace";
  const resource = RESOURCE_MAP[twoSegment] || RESOURCE_MAP[oneSegment] || oneSegment.replace(/-/g, "_");

  return `${resource}.${verb}`;
}

// ─── Entity ID extraction ─────────────────────────────────────────────────────

function inferEntityId(req) {
  const p = req.params || {};
  return p.id || p.reviewId || p.cycleId || p.projectId || p.taskId ||
         p.userId || p.channelId || p.workspaceId || p.sprintId || null;
}

function inferEntityType(action) {
  return action?.split(".")[0] || "workspace";
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function auditWorkspaceActivity(req, res, next) {
  if (!req.workspaceId || !req.user) return next();
  if (req.method === "OPTIONS") return next();
  // Skip the audit-log read endpoint itself to avoid infinite log loops
  if (req.path === "/" && req.baseUrl === "/audit") return next();

  const startedAt = Date.now();

  res.on("finish", () => {
    // Don't log server errors (5xx) — those are noise; keep 4xx for security
    if (res.statusCode >= 500) return;

    const method = req.method.toUpperCase();

    // For plain GETs: store as request.get (filtered from display, kept for debugging)
    if (method === "GET" || method === "HEAD") {
      logAudit({
        workspaceId: req.workspaceId,
        userId: req.user?.id || null,
        action: "request.get",
        entityType: inferEntityType(null),
        entityId: inferEntityId(req),
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"] || null,
        metadata: {
          path: req.originalUrl,
          method,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        },
      }).catch(() => {});
      return;
    }

    // For write operations: derive a meaningful semantic action name
    const action = deriveSemanticAction(method, req.baseUrl || "", req.path || "");

    const bodySummary = redactValue(req.body || {});
    const fileSummary = summarizeFiles(req);

    logAudit({
      workspaceId: req.workspaceId,
      userId: req.user?.id || null,
      action,
      entityType: inferEntityType(action),
      entityId: inferEntityId(req),
      ipAddress: getClientIp(req),
      userAgent: req.headers["user-agent"] || null,
      newValue: Object.keys(bodySummary).length ? bodySummary : undefined,
      metadata: {
        path: req.originalUrl,
        method,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        routeParams: redactValue(req.params || {}),
        query: redactValue(req.query || {}),
        files: fileSummary,
      },
    }).catch(() => {});
  });

  next();
}
