// ai-platform/governance/permissions.js
//
// Epic C — the governance permission matrix (Contract §9): object × verb × role ×
// scope, layered with the lock model. This replaces Epic A's single lock enum with
// full verb-level, role-aware permissions the Studio uses to show/hide/enable
// controls and to authorize writes. Pure. No DB, no I/O.

import { workspaceCanOverride } from "./locks.js";

export const ROLES = Object.freeze([
  "superadmin", "platform_operator", "workspace_admin", "workspace_editor", "workspace_viewer",
]);

export const VERBS = Object.freeze([
  "view", "edit", "override", "test", "publish", "rollback",
  "approve", "clone", "export", "import", "reset", "lock", "delegate",
]);

export const OBJECT_TYPES = Object.freeze([
  "provider", "model", "prompt", "prompt_version", "profile", "policy_set",
  "capability_config", "key_ownership", "budget", "tool", "memory_scope", "retriever",
]);

// Base verb grants per role (before lock/scope refinement).
const ROLE_VERBS = Object.freeze({
  superadmin: new Set(VERBS), // everything, everywhere
  platform_operator: new Set(["view", "edit", "test", "publish", "rollback", "approve", "export", "import"]),
  workspace_admin: new Set(["view", "override", "test", "clone", "export", "reset"]),
  workspace_editor: new Set(["view", "test"]),
  workspace_viewer: new Set(["view"]),
});

const WORKSPACE_ROLES = new Set(["workspace_admin", "workspace_editor", "workspace_viewer"]);

/**
 * Can `role` perform `verb` on an object of `objectType` at `scope`, given the
 * object's `lockLevel`? Separation of duties: the same actor cannot both author
 * and approve (enforced at the API layer via authorId≠approverId, surfaced here
 * via the `isAuthor` flag).
 * @returns {{allowed:boolean, reason?:string}}
 */
export function can({ role, verb, objectType = null, scope = "PLATFORM", lockLevel = "workspace_customizable", isAuthor = false } = {}) {
  if (role === "superadmin") return { allowed: true };

  const verbs = ROLE_VERBS[role];
  if (!verbs) return { allowed: false, reason: "unknown_role" };
  if (!verbs.has(verb)) return { allowed: false, reason: "verb_not_permitted_for_role" };

  // Workspace roles may never act at platform scope.
  if (scope === "PLATFORM" && WORKSPACE_ROLES.has(role)) {
    return { allowed: false, reason: "platform_scope_forbidden_for_workspace_role" };
  }

  // Lock enforcement for mutating verbs at workspace scope.
  if (["override", "edit"].includes(verb) && WORKSPACE_ROLES.has(role)) {
    if (!workspaceCanOverride(lockLevel)) {
      return { allowed: false, reason: lockLevel === "global_locked" ? "object_global_locked" : "workspace_locked_by_platform" };
    }
  }

  // Separation of duties: an author cannot approve their own change.
  if (verb === "approve" && isAuthor) {
    return { allowed: false, reason: "separation_of_duties" };
  }

  return { allowed: true };
}

/**
 * The verbs a role may perform on an object in a scope+lock context — used by the
 * UI to render only the controls a given admin is allowed to see/use.
 * @returns {string[]}
 */
export function permittedVerbs({ role, objectType = null, scope = "PLATFORM", lockLevel = "workspace_customizable" } = {}) {
  return VERBS.filter((verb) => can({ role, verb, objectType, scope, lockLevel }).allowed);
}
