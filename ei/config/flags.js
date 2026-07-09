// ei/config/flags.js
//
// Enterprise Intelligence V2.1 feature flags. Everything defaults OFF so the EI
// pipeline changes NO production behavior until deliberately enabled. Reuses the
// existing envBool helper (no duplicate flag logic).
//
//   EI_V2_ENABLED             master switch for EI V2.1 surfaces (read/UI)
//   EI_EVENT_PIPELINE_ENABLED Phase 1: canonical event ingestion
//   EI_ENABLED_WORKSPACES     comma-separated canary workspace ids

import { envBool } from "../../config/environment.js";

function csv(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function isEiEnabled() {
  return envBool("EI_V2_ENABLED", false);
}

/** Phase 1 ingestion gate (global flag OR per-workspace canary). Default OFF. */
export function isEiEventPipelineEnabled(workspaceId = null) {
  if (envBool("EI_EVENT_PIPELINE_ENABLED", false)) return true;
  if (workspaceId && csv(process.env.EI_ENABLED_WORKSPACES).includes(String(workspaceId))) return true;
  return false;
}

/** Phase 2 attribution gate (global flag OR per-workspace canary). Default OFF. */
export function isEiAttributionEnabled(workspaceId = null) {
  if (envBool("EI_ATTRIBUTION_ENABLED", false)) return true;
  if (workspaceId && csv(process.env.EI_ENABLED_WORKSPACES).includes(String(workspaceId))) return true;
  return false;
}

function gate(flagName, workspaceId) {
  if (envBool(flagName, false)) return true;
  if (workspaceId && csv(process.env.EI_ENABLED_WORKSPACES).includes(String(workspaceId))) return true;
  return false;
}

/** Wave A gates (all default OFF). */
export const isEiEvidenceEnabled = (workspaceId = null) => gate("EI_EVIDENCE_ENABLED", workspaceId);
export const isEiReasoningEnabled = (workspaceId = null) => gate("EI_REASONING_ENABLED", workspaceId);
export const isEiPredictionEnabled = (workspaceId = null) => gate("EI_PREDICTION_ENABLED", workspaceId);

/** Wave B gates (all default OFF).
 *   EI_RECOMMENDATION_ENABLED  Phase 6: deterministic recommendation layer
 *   EI_EXECUTIVE_ENABLED       Phase 7: executive reasoning (question answering)
 *   EI_NARRATION_ENABLED       Phase 8: business narration (presentation only)
 *   EI_METRICS_ENABLED         evidence-backed platform/value metrics
 *   EI_NARRATION_LLM_ENABLED   optional LLM narration path (Contract V2); template fallback always works
 */
export const isEiRecommendationEnabled = (workspaceId = null) => gate("EI_RECOMMENDATION_ENABLED", workspaceId);
export const isEiExecutiveEnabled = (workspaceId = null) => gate("EI_EXECUTIVE_ENABLED", workspaceId);
export const isEiNarrationEnabled = (workspaceId = null) => gate("EI_NARRATION_ENABLED", workspaceId);
export const isEiMetricsEnabled = (workspaceId = null) => gate("EI_METRICS_ENABLED", workspaceId);
export const isEiNarrationLlmEnabled = (workspaceId = null) => gate("EI_NARRATION_LLM_ENABLED", workspaceId);

/** Wave C gates — the closed-loop learning/validation/outcome engine (all default OFF).
 *   EI_OUTCOMES_ENABLED       Outcomes Ledger (immutable outcome records)
 *   EI_EFFECTIVENESS_ENABLED  Recommendation effectiveness (computed)
 *   EI_VALIDATION_ENABLED     Prediction validation (computed)
 *   EI_CALIBRATION_ENABLED    Calibration engine (versioned models)
 *   EI_LEARNING_ENABLED       Learning engine (proposals only, no auto-mutation)
 *   EI_EXPERIMENTS_ENABLED    Experiment engine (auditable)
 *   EI_MEMORY_ENABLED         Organizational memory (versioned)
 *   EI_HEALTH_ENABLED         Platform health (computed)
 */
export const isEiOutcomesEnabled = (workspaceId = null) => gate("EI_OUTCOMES_ENABLED", workspaceId);
export const isEiEffectivenessEnabled = (workspaceId = null) => gate("EI_EFFECTIVENESS_ENABLED", workspaceId);
export const isEiValidationEnabled = (workspaceId = null) => gate("EI_VALIDATION_ENABLED", workspaceId);
export const isEiCalibrationEnabled = (workspaceId = null) => gate("EI_CALIBRATION_ENABLED", workspaceId);
export const isEiLearningEnabled = (workspaceId = null) => gate("EI_LEARNING_ENABLED", workspaceId);
export const isEiExperimentsEnabled = (workspaceId = null) => gate("EI_EXPERIMENTS_ENABLED", workspaceId);
export const isEiMemoryEnabled = (workspaceId = null) => gate("EI_MEMORY_ENABLED", workspaceId);
export const isEiHealthEnabled = (workspaceId = null) => gate("EI_HEALTH_ENABLED", workspaceId);

/** Enterprise Intelligence Studio — the read-only API/UI surface over all EI subsystems.
 *  Master gate for the /intelligence-studio routes; default OFF. */
export const isEiStudioEnabled = (workspaceId = null) => gate("EI_STUDIO_ENABLED", workspaceId);
