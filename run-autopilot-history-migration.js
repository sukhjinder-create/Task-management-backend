/**
 * Run autopilot history indexing migration
 */

import pool from "./db.js";
import fs from "fs";

async function runMigration() {
  try {
    console.log("Running autopilot history indexing migration...\n");

    const sql = fs.readFileSync(
      "./migrations/20260306_add_autopilot_history_indexes.sql",
      "utf8"
    );

    await pool.query(sql);
    console.log("Indexes created successfully.\n");

    const indexRows = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND (
          indexname LIKE 'idx_autopilot_actions_workspace_created_at%'
          OR indexname LIKE 'idx_autopilot_actions_workspace_project_created_at%'
          OR indexname LIKE 'idx_autopilot_actions_workspace_status_created_at%'
          OR indexname LIKE 'idx_autopilot_actions_workspace_action_type%'
          OR indexname LIKE 'idx_autopilot_decisions_action_decision_at%'
        )
      ORDER BY indexname
    `);

    console.log("Verified indexes:");
    indexRows.rows.forEach((row) => console.log(`  - ${row.indexname}`));
  } catch (err) {
    console.error("Migration failed:", err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

runMigration();
