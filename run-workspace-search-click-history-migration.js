import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260408_workspace_search_click_history.sql",
      "utf8"
    );

    console.log("Running workspace search click history migration...");
    await pool.query(sql);
    console.log("Workspace search click history migration completed successfully.");
  } catch (error) {
    console.error("Workspace search click history migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
