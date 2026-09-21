import db from "../db.js";

export const ENTERPRISE_PERMISSIONS = Object.freeze([
  "read:tasks", "write:tasks",
  "read:projects", "write:projects",
  "read:assurance", "write:assurance",
  "read:documents", "write:documents",
  "read:collaboration", "write:collaboration",
  "read:people", "write:people",
  "read:reports",
  "read:audit",
  "manage:users", "manage:workspace", "manage:security",
  "manage:privacy", "manage:integrations", "manage:billing",
]);

const RESOURCE_PERMISSIONS = new Map([
  ["tasks", "tasks"], ["subtasks", "tasks"], ["comments", "tasks"],
  ["task-links", "tasks"], ["watchers", "tasks"], ["votes", "tasks"],
  ["issue-templates", "tasks"], ["saved-filters", "tasks"],
  ["projects", "projects"], ["project-statuses", "projects"],
  ["assurance", "assurance"], ["goals", "assurance"],
  ["wiki", "documents"],
  ["chat", "collaboration"], ["huddle", "collaboration"], ["notifications", "collaboration"],
  ["attendance", "people"], ["leave", "people"], ["holidays", "people"], ["reviews", "people"],
  ["reports", "reports"], ["dashboard", "reports"], ["intelligence", "reports"],
]);

const MANAGE_PERMISSIONS = new Map([
  ["users", "manage:users"],
  ["workspaces", "manage:workspace"],
  ["settings", "manage:workspace"],
  ["enterprise-security", "manage:security"],
  ["audit", "read:audit"],
  ["gdpr", "manage:privacy"],
  ["api-keys", "manage:integrations"],
  ["webhooks", "manage:integrations"],
  ["integrations", "manage:integrations"],
  ["payments", "manage:billing"],
]);

function topLevelResource(req) {
  return String(req.baseUrl || req.originalUrl || req.path || "")
    .split("?")[0].split("/").filter(Boolean)[0] || "";
}

export function requiredWorkspacePermission(req) {
  const resource = topLevelResource(req);
  if (MANAGE_PERMISSIONS.has(resource)) return MANAGE_PERMISSIONS.get(resource);
  const normalized = RESOURCE_PERMISSIONS.get(resource);
  if (!normalized) return null;
  const verb = ["GET", "HEAD", "OPTIONS"].includes(String(req.method).toUpperCase()) ? "read" : "write";
  return `${verb}:${normalized}`;
}

export function hasWorkspacePermission(permissions, required) {
  if (!required) return true;
  const granted = new Set(Array.isArray(permissions) ? permissions : []);
  if (granted.has("*") || granted.has(required)) return true;
  if (required.startsWith("read:")) return granted.has(`write:${required.slice(5)}`);
  return false;
}

export function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) throw new Error("permissions must be an array");
  const unique = [...new Set(permissions.map((permission) => String(permission).trim()))];
  const invalid = unique.filter((permission) => !ENTERPRISE_PERMISSIONS.includes(permission));
  if (invalid.length) throw new Error(`Unsupported permission: ${invalid.join(", ")}`);
  return unique;
}

export async function getWorkspaceSecurityContext(workspaceId, userId, database = db) {
  const result = await database.query(
    `SELECT role.id AS enterprise_role_id, role.base_role, role.permissions,
            policy.require_mfa, policy.enforce_sso, policy.session_max_age_minutes,
            policy.idle_timeout_minutes, policy.allowed_ip_cidrs,
            policy.guest_access_enabled, policy.api_key_max_age_days,
            policy.audit_retention_days, policy.data_retention_days,
            COALESCE(member.billing_status, 'active') AS billing_status,
            COALESCE(app_user.mfa_enabled, false) AS mfa_enabled
       FROM users app_user
       LEFT JOIN workspace_users member
         ON member.user_id = app_user.id AND member.workspace_id = $1
       LEFT JOIN enterprise_roles role
         ON role.id = member.enterprise_role_id AND role.workspace_id = member.workspace_id
       LEFT JOIN workspace_security_policies policy ON policy.workspace_id = $1
      WHERE app_user.id = $2 AND app_user.workspace_id = $1`,
    [workspaceId, userId]
  );
  return result.rows[0] || null;
}

export async function isRequestIpAllowed(ipAddress, cidrs, database = db) {
  if (!Array.isArray(cidrs) || cidrs.length === 0) return true;
  const ip = String(ipAddress || "").split(",")[0].trim().replace(/^::ffff:/, "");
  if (!ip) return false;
  try {
    const result = await database.query(
      "SELECT $1::inet <<= ANY($2::inet[]) AS allowed",
      [ip, cidrs]
    );
    return result.rows[0]?.allowed === true;
  } catch {
    return false;
  }
}

export async function getSessionPolicy(workspaceId, database = db) {
  if (!workspaceId || workspaceId === "GLOBAL") {
    return { maxAgeMinutes: 10080, idleMinutes: 10080 };
  }
  const result = await database.query(
    `SELECT session_max_age_minutes, idle_timeout_minutes
       FROM workspace_security_policies WHERE workspace_id = $1`,
    [workspaceId]
  );
  return {
    maxAgeMinutes: Number(result.rows[0]?.session_max_age_minutes) || 10080,
    idleMinutes: Number(result.rows[0]?.idle_timeout_minutes) || 10080,
  };
}
