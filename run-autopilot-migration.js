/**
 * Run AI Autopilot tables migration
 */

import pool from "./db.js";
import fs from "fs";

async function runMigration() {
  try {
    console.log("🤖 Creating AI Autopilot Mode tables...\n");

    const sql = fs.readFileSync(
      "./migrations/20260306_create_autopilot_tables.sql",
      "utf8"
    );

    await pool.query(sql);

    console.log("✅ Tables created successfully!\n");

    // Verify tables
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'autopilot%'
      ORDER BY table_name
    `);

    console.log("📊 Created tables:");
    console.log("═══════════════════════════════════════════\n");
    tables.rows.forEach((t) => {
      console.log(`  ✓ ${t.table_name}`);
    });

    // Check view
    const views = await pool.query(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name LIKE '%workload%'
    `);

    console.log("\n📊 Created views:");
    console.log("═══════════════════════════════════════════\n");
    views.rows.forEach((v) => {
      console.log(`  ✓ ${v.table_name}`);
    });

    console.log("\n═══════════════════════════════════════════");
    console.log("🤖 AI Autopilot Mode database ready!");
    console.log("Next: Implement autopilot.engine.js");

  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

runMigration();
