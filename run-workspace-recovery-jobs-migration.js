import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260409_workspace_recovery_jobs.sql",
      "utf8"
    );

    console.log("Running workspace recovery jobs migration...");
    await pool.query(sql);
    console.log("Workspace recovery jobs migration completed successfully.");
  } catch (error) {
    console.error("Workspace recovery jobs migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
