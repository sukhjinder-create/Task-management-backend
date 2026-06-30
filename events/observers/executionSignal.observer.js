import pool from "../../db.js";
import { EVENT_TYPES } from "../eventTypes.js";

export async function executionSignalObserver(event) {
  if (
    event.eventType !== EVENT_TYPES.INTEGRATION_ACTIVITY_OBSERVED
    && event.eventType !== EVENT_TYPES.INTEGRATION_TASK_COMPLETED
  ) {
    return;
  }

  const externalId = event.metadata?.external_entity_id || event.metadata?.externalId;
  if (!externalId) return;

  await pool.query(
    `
    INSERT INTO workspace_execution_signals (
      workspace_id, source, external_id, signal_type, metadata
    ) VALUES ($1, $2, $3, $4, $5)
    `,
    [
      event.workspaceId,
      event.metadata?.provider || "integration",
      externalId,
      event.eventType,
      event.metadata || {},
    ]
  );
}
