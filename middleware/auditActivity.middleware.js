import { logAudit } from "../services/audit.service.js";

const SENSITIVE_KEYS = [
  "password",
  "token",
  "secret",
  "authorization",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "client_secret",
  "code",
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function redactValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).slice(0, 40).map(([key, entryValue]) => {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.some((candidate) => lowerKey.includes(candidate))) {
          return [key, "[redacted]"];
        }
        return [key, redactValue(entryValue, depth + 1)];
      })
    );
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  return value;
}

function summarizeFiles(req) {
  if (Array.isArray(req.files)) {
    return req.files.map((file) => ({
      field: file.fieldname,
      name: file.originalname,
      size: file.size,
      type: file.mimetype,
    }));
  }

  if (req.files && isPlainObject(req.files)) {
    return Object.fromEntries(
      Object.entries(req.files).map(([field, files]) => [
        field,
        Array.isArray(files)
          ? files.map((file) => ({
              name: file.originalname,
              size: file.size,
              type: file.mimetype,
            }))
          : [],
      ])
    );
  }

  if (req.file) {
    return [
      {
        field: req.file.fieldname,
        name: req.file.originalname,
        size: req.file.size,
        type: req.file.mimetype,
      },
    ];
  }

  return null;
}

function inferEntityType(req) {
  const segments = String(req.baseUrl || req.path || "")
    .split("/")
    .filter(Boolean);
  return segments[0] || "workspace";
}

function inferEntityId(req) {
  const params = req.params || {};
  return (
    params.id ||
    params.projectId ||
    params.taskId ||
    params.userId ||
    params.channelId ||
    params.workspaceId ||
    null
  );
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

export function auditWorkspaceActivity(req, res, next) {
  if (!req.workspaceId || !req.user) {
    return next();
  }

  if (req.path === "/" && req.baseUrl === "/audit") {
    return next();
  }

  if (req.method === "OPTIONS") {
    return next();
  }

  const startedAt = Date.now();

  res.on("finish", () => {
    if (res.statusCode >= 500) return;

    const bodySummary = redactValue(req.body || {});
    const querySummary = redactValue(req.query || {});
    const fileSummary = summarizeFiles(req);

    logAudit({
      workspaceId: req.workspaceId,
      userId: req.user?.id || null,
      action: `request.${String(req.method || "get").toLowerCase()}`,
      entityType: inferEntityType(req),
      entityId: inferEntityId(req),
      ipAddress: getClientIp(req),
      userAgent: req.headers["user-agent"] || null,
      metadata: {
        path: req.originalUrl,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        routeParams: redactValue(req.params || {}),
        query: querySummary,
        body: bodySummary,
        files: fileSummary,
      },
    }).catch(() => {});
  });

  next();
}
