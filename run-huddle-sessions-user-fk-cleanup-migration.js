import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260825b_huddle_sessions_user_fk_cleanup.sql",
      "utf8"
    );

    console.log("Running huddle_sessions user FK cleanup migration...");
    await pool.query(sql);
    console.log("Huddle_sessions user FK cleanup migration completed successfully.");
  } catch (error) {
    console.error("Huddle_sessions user FK cleanup migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
