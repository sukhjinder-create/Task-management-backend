/**
 * Run attendance_daily table migration
 */

import pool from "./db.js";
import fs from "fs";

async function runMigration() {
  try {
    console.log("🚀 Running attendance_daily table migration...\n");

    const sql = fs.readFileSync(
      "./migrations/20260305_create_attendance_daily_table.sql",
      "utf8"
    );

    await pool.query(sql);

    console.log("✅ Migration completed successfully!\n");

    // Verify the table was created
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'attendance_daily'
      ORDER BY ordinal_position
    `);

    console.log("📊 Table structure:");
    console.log("═══════════════════════════════════════════\n");
    result.rows.forEach((col) => {
      console.log(`  ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });

    console.log("\n═══════════════════════════════════════════");
    console.log("✅ attendance_daily table is ready!");
    console.log("You can now use the /admin/attendance/recalculate endpoint.");

  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

runMigration();
