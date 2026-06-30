import pool from "../../db.js";
import { normalizeMode } from "../shared/runtimeUtils.js";

const DEFAULT_TIMEOUT_MS = 2500;

export function defaultRuntimeSettings(workspaceId = null) {
  return {
    workspace_id: workspaceId,
    mode: normalizeMode(process.env.ADAPTIVE_RUNTIME_DEFAULT_MODE, "shadow"),
    event_capture_enabled: process.env.ADAPTIVE_EVENT_CAPTURE_ENABLED !== "false",
    workflow_enabled: process.env.ADAPTIVE_WORKFLOWS_ENABLED === "true",
    default_approval_mode: "approval_required",
    enabled_capabilities: [],
    context_limits: { memoryEntries: 10, timeoutMs: DEFAULT_TIMEOUT_MS },
    policy: {},
    version: 1,
    source: "environment_default",
  };
}

export async function getRuntimeSettings(workspaceId) {
  const fallback = defaultRuntimeSettings(workspaceId);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM adaptive_runtime_settings WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    );
    return rows[0] ? { ...fallback, ...rows[0], source: "workspace" } : fallback;
  } catch (error) {
    if (error?.code === "42P01") return fallback;
    throw error;
  }
}

export async function updateRuntimeSettings({ workspaceId, actorUserId, patch = {} }) {
  const current = await getRuntimeSettings(workspaceId);
  const mode = normalizeMode(patch.mode, current.mode);
  const approvalMode = ["automatic", "approval_required", "manual_only"].includes(patch.defaultApprovalMode)
    ? patch.defaultApprovalMode
    : current.default_approval_mode;
  const eventCaptureEnabled = patch.eventCaptureEnabled ?? current.event_capture_enabled;
  const workflowEnabled = patch.workflowEnabled ?? current.workflow_enabled;
  const enabledCapabilities = Array.isArray(patch.enabledCapabilities)
    ? patch.enabledCapabilities.map(String)
    : current.enabled_capabilities;
  const contextLimits = { ...(current.context_limits || {}), ...(patch.contextLimits || {}) };
  const policy = { ...(current.policy || {}), ...(patch.policy || {}) };

  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_runtime_settings (
      workspace_id, mode, event_capture_enabled, workflow_enabled,
      default_approval_mode, enabled_capabilities, context_limits, policy, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)
    ON CONFLICT (workspace_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      event_capture_enabled = EXCLUDED.event_capture_enabled,
      workflow_enabled = EXCLUDED.workflow_enabled,
      default_approval_mode = EXCLUDED.default_approval_mode,
      enabled_capabilities = EXCLUDED.enabled_capabilities,
      context_limits = EXCLUDED.context_limits,
      policy = EXCLUDED.policy,
      version = adaptive_runtime_settings.version + 1,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
    `,
    [
      workspaceId,
      mode,
      Boolean(eventCaptureEnabled),
      Boolean(workflowEnabled),
      approvalMode,
      JSON.stringify(enabledCapabilities),
      JSON.stringify(contextLimits),
      JSON.stringify(policy),
      actorUserId || null,
    ]
  );
  return rows[0];
}

export function capabilityEnabled(settings, capabilityKey) {
  const allowlist = Array.isArray(settings?.enabled_capabilities) ? settings.enabled_capabilities : [];
  return allowlist.length === 0 || allowlist.includes(capabilityKey);
}
