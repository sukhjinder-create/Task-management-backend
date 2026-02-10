import pool from "../../db.js";

/**
 * Deletes old raw events based on retention policy.
 *
 * DEFAULT POLICY:
 * - Keep raw events for 30 days
 * - Monthly summaries will come later
 */
export async function cleanupOldWorkspaceEvents(days = 30) {
  await pool.query(
    `
    DELETE FROM workspace_events
    WHERE created_at < NOW() - INTERVAL '${days} days'
    `
  );

  console.log(`🧹 Workspace events older than ${days} days cleaned up`);
}
