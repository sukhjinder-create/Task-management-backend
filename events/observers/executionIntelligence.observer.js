import { EVENT_TYPES } from "../eventTypes.js";
import { recomputeWorkspaceHealth } 
  from "../../services/workspaceHealth.service.js";

/**
 * Reacts to execution signals and updates intelligence automatically
 */
export async function executionIntelligenceObserver(event) {
  try {
    // React to ALL execution-changing integration events
if (
  event.eventType !== EVENT_TYPES.INTEGRATION_TASK_COMPLETED &&
  event.eventType !== EVENT_TYPES.INTEGRATION_TASK_UPDATED &&
  event.eventType !== EVENT_TYPES.INTEGRATION_ACTIVITY_OBSERVED
) {
  return;
}
    console.log(
      "⚡ Execution intelligence triggered for workspace:",
      event.workspaceId
    );

    // Recalculate workspace health
    await recomputeWorkspaceHealth(event.workspaceId);

  } catch (err) {
    console.error(
      "Execution intelligence observer failed:",
      err.message
    );
  }
}