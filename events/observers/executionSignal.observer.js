console.log("🧠 Execution observer ACTIVE");
import pool from "../../db.js";
import { EVENT_TYPES } from "../eventTypes.js";

export async function executionSignalObserver(event) {
    console.log("🧠 Execution observer received:", event.eventType);
    // 🚫 Prevent integration feedback loops
if (event.origin === "integration") {
  return;
}
  try {
    if (
      event.eventType !== EVENT_TYPES.INTEGRATION_ACTIVITY_OBSERVED &&
      event.eventType !== EVENT_TYPES.INTEGRATION_TASK_COMPLETED
    ) {
      return;
    }

    const externalId =
      event.metadata?.external_entity_id;

    if (!externalId) return;

    await pool.query(
      `
      INSERT INTO workspace_execution_signals (
        workspace_id,
        source,
        external_id,
        signal_type,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        event.workspaceId,
        event.metadata.provider,
        externalId,
        event.eventType,
        event.metadata,
      ]
    );

  } catch (err) {
    console.error("Execution signal observer failed:", err.message);
  }
}