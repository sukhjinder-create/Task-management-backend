// ai-platform/config/featureFlag.js
//
// Single switch that decides whether AI traffic flows through the new
// centralized AI Platform gateway or the legacy per-provider path in
// services/llm.js.
//
// DEFAULT = OFF. With the flag off, generateText() behaves byte-for-byte like
// the pre-platform implementation — this is what guarantees "no regressions"
// during rollout. Rollback for the entire platform is: set AI_PLATFORM_ENABLED=false.
//
// The flag can be forced on for a subset of workspaces via
// AI_PLATFORM_ENABLED_WORKSPACES (comma-separated) so the migration can be
// canaried before global enablement.

import { envBool } from "../../config/environment.js";

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Is the AI Platform gateway enabled for this request?
 * @param {string|null} workspaceId
 * @returns {boolean}
 */
export function isAiPlatformEnabled(workspaceId = null) {
  if (envBool("AI_PLATFORM_ENABLED", false)) return true;

  const canaryWorkspaces = csv(process.env.AI_PLATFORM_ENABLED_WORKSPACES);
  if (workspaceId && canaryWorkspaces.includes(String(workspaceId))) return true;

  return false;
}

/**
 * Should the gateway persist request telemetry? Telemetry is best-effort and
 * can be disabled independently (e.g., if the log table is not yet migrated).
 */
export function isAiTelemetryEnabled() {
  return envBool("AI_PLATFORM_TELEMETRY", true);
}
