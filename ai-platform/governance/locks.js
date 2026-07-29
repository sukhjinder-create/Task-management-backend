// ai-platform/governance/locks.js
//
// Epic C — the enterprise lock/inheritance model as executable code (Contract §9).
// This is the canonical, Studio-facing implementation of the 3 lock levels.
// (The runtime resolver enforces the SAME semantics in config/resolver.js#pickWithLock;
// a parity test asserts they agree — no behavioral drift.)
//
//   global_locked          → platform value wins; workspace CANNOT override
//   workspace_customizable → workspace MAY override the platform default
//   workspace_locked        → a specific workspace is pinned by the platform
//
// Pure. No DB, no I/O.

export const LOCK_LEVELS = Object.freeze(["global_locked", "workspace_customizable", "workspace_locked"]);

export function isLockLevel(level) {
  return LOCK_LEVELS.includes(level);
}

/** Can a workspace admin change this object at all? Only when customizable. */
export function workspaceCanOverride(lockLevel) {
  return lockLevel === "workspace_customizable";
}

/**
 * Resolve the effective value under the lock model — identical semantics to the
 * runtime resolver's pickWithLock.
 * @param {string} lockLevel
 * @param {*} platformValue
 * @param {*} workspaceValue
 */
export function resolveLockedValue(lockLevel, platformValue, workspaceValue) {
  if (lockLevel === "global_locked") return platformValue;           // workspace cannot override
  if (workspaceValue != null) return workspaceValue;                  // customizable / workspace_locked (pinned)
  return platformValue;
}

/**
 * UI helper: describe the lock state for a non-technical admin.
 * @returns {{editable:boolean, badge:string, help:string}}
 */
export function describeLock(lockLevel) {
  switch (lockLevel) {
    case "global_locked":
      return { editable: false, badge: "Locked by platform", help: "This setting is managed centrally and can't be changed for your workspace." };
    case "workspace_locked":
      return { editable: false, badge: "Pinned for this workspace", help: "The platform has set a specific value for your workspace." };
    case "workspace_customizable":
    default:
      return { editable: true, badge: "Customizable", help: "You can override the platform default for your workspace." };
  }
}
