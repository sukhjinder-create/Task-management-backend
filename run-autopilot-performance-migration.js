/**
 * Run autopilot performance migration
 */

import pool from "./db.js";
import fs from "fs";

async function runMigration() {
  try {
    console.log("Running autopilot performance migration...\n");

    const sql = fs.readFileSync(
      "./migrations/20260307_optimize_autopilot_performance.sql",
      "utf8"
    );

    await pool.query(sql);
    console.log("Performance indexes created successfully.\n");

    const { rows } = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND (
          indexname LIKE 'idx_tasks_workspace_project_assigned_status%'
          OR indexname LIKE 'idx_tasks_workspace_assigned_status%'
          OR indexname LIKE 'idx_tasks_workspace_project_due_active%'
          OR indexname LIKE 'idx_tasks_workspace_due_active%'
          OR indexname LIKE 'idx_tasks_workspace_project_updated_active%'
          OR indexname LIKE 'idx_tasks_workspace_updated_active%'
          OR indexname LIKE 'idx_autopilot_actions_dedupe_window%'
          OR indexname LIKE 'idx_autopilot_actions_pending_workspace_expires%'
        )
      ORDER BY indexname
    `);

    console.log("Verified indexes:");
    rows.forEach((r) => console.log(`  - ${r.indexname}`));
  } catch (err) {
    console.error("Migration failed:", err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

runMigration();
