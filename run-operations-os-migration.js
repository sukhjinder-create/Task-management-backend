import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260408_operations_os.sql",
      "utf8"
    );

    console.log("Running Operations OS migration...");
    await pool.query(sql);
    console.log("Operations OS migration completed successfully.");
  } catch (error) {
    console.error("Operations OS migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
