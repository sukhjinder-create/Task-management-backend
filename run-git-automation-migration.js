import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running git automation migration...");

    const baseSql = fs.readFileSync(
      "./migrations/20260307_add_git_automation_tables.sql",
      "utf8"
    );
    const inferenceSql = fs.readFileSync(
      "./migrations/20260307_add_git_automation_inference_columns.sql",
      "utf8"
    );

    await pool.query(baseSql);
    await pool.query(inferenceSql);

    const { rows: settingsCols } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'git_project_automation_settings'
      ORDER BY ordinal_position
    `);

    const { rows: eventCols } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'git_automation_events'
      ORDER BY ordinal_position
    `);

    console.log("Migration complete.");
    console.log(`git_project_automation_settings columns: ${settingsCols.length}`);
    console.log(`git_automation_events columns: ${eventCols.length}`);
  } catch (error) {
    console.error("Git automation migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
