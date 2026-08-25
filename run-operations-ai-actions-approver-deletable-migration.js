import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    const sql = fs.readFileSync(
      "./migrations/20260825f_operations_ai_actions_approver_deletable.sql",
      "utf8"
    );

    console.log("Running operations_ai_actions approver-deletable migration...");
    await pool.query(sql);
    console.log("Operations_ai_actions approver-deletable migration completed successfully.");
  } catch (error) {
    console.error("Operations_ai_actions approver-deletable migration failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
