// execution/config.js
//
// Enterprise Work Intelligence Platform V3 — execution-substrate feature flags.
// EVERYTHING defaults OFF so mounting this platform changes NO production behavior
// until deliberately enabled. Reuses the existing envBool helper (no duplicate flag
// logic). The master flag gates the whole surface (routes 404 when OFF); the
// side-effects flag is the SAFETY GATE — real capability adapters (create task, notify,
// …) only mutate anything when it is explicitly enabled. Everything else runs as a
// deterministic dry-run.
//
//   EXEC_ENABLED               master switch (routes + services)
//   EXEC_SIDE_EFFECTS_ENABLED  allow real capability adapters to mutate live systems
//   EXEC_DECISIONS_ENABLED     Decision engine
//   EXEC_APPROVALS_ENABLED     Approval engine
//   EXEC_WORKFLOW_ENABLED      Workflow engine
//   EXEC_POLICY_ENABLED        Policy engine
//   EXEC_AUTOMATION_ENABLED    Automation engine
//   EXEC_ANALYTICS_ENABLED     Execution analytics
//   EXEC_ENABLED_WORKSPACES    comma-separated canary workspace ids

import { envBool } from "../config/environment.js";

function csv(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function gate(flagName, workspaceId) {
  if (envBool(flagName, false)) return true;
  if (workspaceId && csv(process.env.EXEC_ENABLED_WORKSPACES).includes(String(workspaceId))) return true;
  return false;
}

/** Master gate — when OFF the whole /execution surface is inert (routes return 404). */
export const isExecutionEnabled = (workspaceId = null) => gate("EXEC_ENABLED", workspaceId);

/** SAFETY GATE — when OFF, capability adapters never mutate live systems (dry-run only). */
export const areSideEffectsEnabled = (workspaceId = null) => gate("EXEC_SIDE_EFFECTS_ENABLED", workspaceId);

export const isDecisionsEnabled = (workspaceId = null) => gate("EXEC_DECISIONS_ENABLED", workspaceId);
export const isApprovalsEnabled = (workspaceId = null) => gate("EXEC_APPROVALS_ENABLED", workspaceId);
export const isWorkflowEnabled = (workspaceId = null) => gate("EXEC_WORKFLOW_ENABLED", workspaceId);
export const isPolicyEnabled = (workspaceId = null) => gate("EXEC_POLICY_ENABLED", workspaceId);
export const isAutomationEnabled = (workspaceId = null) => gate("EXEC_AUTOMATION_ENABLED", workspaceId);
export const isAnalyticsEnabled = (workspaceId = null) => gate("EXEC_ANALYTICS_ENABLED", workspaceId);
