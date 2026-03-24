import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running sprint-goal sync migration...");

    const sql = fs.readFileSync(
      "./migrations/20260324_sprint_goal_sync.sql",
      "utf8"
    );

    await pool.query(sql);

    // Verify
    const { rows: sprintCols } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sprints' AND column_name = 'is_hidden'
    `);

    const { rows: linkCols } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'okr_sprint_links'
    `);

    console.log("Migration complete.");
    console.log(`sprints.is_hidden column: ${sprintCols.length > 0 ? "OK" : "MISSING"}`);
    console.log(`okr_sprint_links table columns: ${linkCols.length}`);
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
