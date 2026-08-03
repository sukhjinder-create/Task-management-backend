import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running universal integrations migration...");
    const sql = fs.readFileSync("./migrations/20260803_universal_integrations.sql", "utf8");
    await pool.query(sql);

    const { rows: tables } = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'integration_sync_config',
          'custom_integration_providers',
          'integration_webhook_endpoints'
        )
      ORDER BY table_name
    `);
    console.log("Tables present:", tables.map((r) => r.table_name).join(", "));

    const { rows: backfilled } = await pool.query(
      "SELECT count(*)::int AS n FROM integration_sync_config"
    );
    console.log(`Sync config rows (backfilled from connected integrations): ${backfilled[0].n}`);

    console.log("Universal integrations migration complete.");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  }
}

runMigration();
