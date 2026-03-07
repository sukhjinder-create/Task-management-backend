/**
 * Run dashboard performance indexes migration
 */

import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running dashboard performance migration...\n");
    const sql = fs.readFileSync(
      "./migrations/20260307_dashboard_performance_indexes.sql",
      "utf8"
    );
    await pool.query(sql);
    console.log("Dashboard indexes created successfully.");
  } catch (err) {
    console.error("Dashboard migration failed:", err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

runMigration();
