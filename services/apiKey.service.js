import bcrypt from "bcryptjs";
import db from "../db.js";

const API_KEY_PATTERN = /^(?:asy_[a-f0-9]{64}|tm_[a-f0-9]{48})$/i;

const RESOURCE_ALIASES = new Map([
  ["subtasks", "tasks"],
  ["comments", "tasks"],
  ["task-links", "tasks"],
  ["watchers", "tasks"],
  ["votes", "tasks"],
  ["project-statuses", "projects"],
  ["saved-filters", "tasks"],
  ["issue-templates", "tasks"],
  ["time-tracking", "tasks"],
]);

export const SUPPORTED_API_KEY_SCOPES = Object.freeze([
  "read:tasks", "write:tasks",
  "read:projects", "write:projects",
  "read:reports",
  "read:assurance", "write:assurance",
  "read:webhooks", "write:webhooks",
]);

export function requiredScopeForRequest(req) {
  const resource = String(req.baseUrl || req.path || req.originalUrl || "")
    .split("?")[0]
    .split("/")
    .filter(Boolean)[0];
  if (!resource) return null;

  const normalized = RESOURCE_ALIASES.get(resource) || resource;
  const verb = ["GET", "HEAD", "OPTIONS"].includes(String(req.method).toUpperCase())
    ? "read"
    : "write";
  return `${verb}:${normalized}`;
}

export function apiKeyHasScope(scopes, requiredScope) {
  const granted = new Set(Array.isArray(scopes) ? scopes : []);
  if (!requiredScope) return false;
  if (granted.has("*") || granted.has("admin") || granted.has(requiredScope)) return true;

  const [verb, resource] = requiredScope.split(":");
  if (granted.has(`${verb}:*`)) return true;
  // Write credentials can safely read the same resource without forcing admins
  // to grant two nearly identical permissions.
  return verb === "read" && granted.has(`write:${resource}`);
}

export function validateApiKeyScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("At least one API key scope is required");
  }
  const unique = [...new Set(scopes.map((scope) => String(scope).trim()))];
  const invalid = unique.filter((scope) => !SUPPORTED_API_KEY_SCOPES.includes(scope));
  if (invalid.length) throw new Error(`Unsupported API key scope: ${invalid.join(", ")}`);
  return unique;
}

export async function authenticateApiKey(rawKey, database = db) {
  const candidate = String(rawKey || "").trim();
  if (!API_KEY_PATTERN.test(candidate)) return null;

  const result = await database.query(
    `SELECT ak.id, ak.workspace_id, ak.user_id, ak.key_hash, ak.scopes,
            u.username, u.email, u.role, u.email_verified_at
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       JOIN workspaces w ON w.id = ak.workspace_id
      WHERE ak.is_active = true
        AND (ak.expires_at IS NULL OR ak.expires_at > now())
        AND (w.status IS NULL OR w.status = 'active')
        AND ak.key_prefix = LEFT($1, length(ak.key_prefix))`,
    [candidate]
  );

  for (const row of result.rows) {
    if (!(await bcrypt.compare(candidate, row.key_hash))) continue;

    await database.query(
      "UPDATE api_keys SET last_used_at = now() WHERE id = $1",
      [row.id]
    );
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      scopes: row.scopes || [],
      user: {
        id: row.user_id,
        username: row.username,
        email: row.email,
        role: row.role || "user",
        workspaceId: row.workspace_id,
        workspace_id: row.workspace_id,
        email_verified_at: row.email_verified_at,
      },
    };
  }

  return null;
}

export const __testables = { API_KEY_PATTERN };
