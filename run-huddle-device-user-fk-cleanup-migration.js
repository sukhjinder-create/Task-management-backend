import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260825d_huddle_device_user_fk_cleanup.sql",
      "utf8"
    );

    console.log("Running huddle device user FK cleanup migration...");
    await pool.query(sql);
    console.log("Huddle device user FK cleanup migration completed successfully.");
  } catch (error) {
    console.error("Huddle device user FK cleanup migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
