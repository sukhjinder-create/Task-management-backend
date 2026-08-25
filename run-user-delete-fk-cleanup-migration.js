import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260825_user_delete_fk_cleanup.sql",
      "utf8"
    );

    console.log("Running user-delete FK cleanup migration...");
    await pool.query(sql);
    console.log("User-delete FK cleanup migration completed successfully.");
  } catch (error) {
    console.error("User-delete FK cleanup migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
