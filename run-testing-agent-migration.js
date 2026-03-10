import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running testing agent migration...");

    const sql = fs.readFileSync(
      "./migrations/20260308_add_testing_agent_tables.sql",
      "utf8"
    );
    const projectProfileSql = fs.readFileSync(
      "./migrations/20260308_add_testing_agent_project_profiles.sql",
      "utf8"
    );

    await pool.query(sql);
    await pool.query(projectProfileSql);

    const { rows: settingsCols } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'testing_agent_settings'
      ORDER BY ordinal_position
    `);

    const { rows: runCols } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'testing_agent_runs'
      ORDER BY ordinal_position
    `);
    const { rows: profileCols } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'testing_agent_project_profiles'
      ORDER BY ordinal_position
    `);

    console.log("Testing agent migration complete.");
    console.log(`testing_agent_settings columns: ${settingsCols.length}`);
    console.log(`testing_agent_runs columns: ${runCols.length}`);
    console.log(`testing_agent_project_profiles columns: ${profileCols.length}`);
  } catch (error) {
    console.error("Testing agent migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
