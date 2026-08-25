import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260825g_guest_and_workspace_delete_traps.sql",
      "utf8"
    );

    console.log("Running guest/workspace delete-trap migration...");
    await pool.query(sql);
    console.log("Guest/workspace delete-trap migration completed successfully.");
  } catch (error) {
    console.error("Guest/workspace delete-trap migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
