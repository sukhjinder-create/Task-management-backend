// ei/orchestrator/service.js
//
// Enterprise Intelligence orchestration entry point. Flag-gated per workspace; when
// enabled it runs the full deterministic pipeline for that workspace. Additive — never
// runs unless EI_ORCHESTRATOR_ENABLED (or the EI_ENABLED_WORKSPACES canary) is set.

import { runPipelineForWorkspace } from "./pipeline.js";
import { isEiOrchestratorEnabled } from "../config/flags.js";

/** @param {object} args { workspaceId, now } @param {object} [deps] */
export async function orchestrateWorkspace({ workspaceId, now } = {}, deps = {}) {
  if (!isEiOrchestratorEnabled(workspaceId)) return { skipped: "flag_off" };
  return runPipelineForWorkspace({ workspaceId, now }, deps);
}
