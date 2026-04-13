import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260409_ensure_backup_logs.sql",
      "utf8"
    );

    console.log("Running backup logs migration...");
    await pool.query(sql);
    console.log("Backup logs migration completed successfully.");
  } catch (error) {
    console.error("Backup logs migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
