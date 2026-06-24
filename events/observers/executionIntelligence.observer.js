import { queueImpactedIntelligenceRecalculation } from "../../intelligence/realtime/recalculation.service.js";
import { EVENT_TYPES } from "../eventTypes.js";

/**
 * Routes integration execution signals into the authoritative intelligence engine.
 */
export async function executionIntelligenceObserver(event) {
  try {
    if (
      event.eventType !== EVENT_TYPES.INTEGRATION_TASK_COMPLETED &&
      event.eventType !== EVENT_TYPES.INTEGRATION_TASK_UPDATED &&
      event.eventType !== EVENT_TYPES.INTEGRATION_ACTIVITY_OBSERVED
    ) {
      return;
    }

    console.log("[enterprise-intelligence] Integration execution signal:", event.workspaceId);

    queueImpactedIntelligenceRecalculation({
      workspaceId: event.workspaceId,
      reason: "integration_execution_signal",
      sourceType: "integration_event",
      sourceId: event.metadata?.external_entity_id || event.metadata?.external_id || null,
      metadata: {
        eventType: event.eventType,
        provider: event.metadata?.provider || null,
      },
    });
  } catch (err) {
    console.error("Execution intelligence observer failed:", err.message);
  }
}
