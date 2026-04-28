import pool from "./db.js";
import fs from "fs";

async function runMigration() {
  try {
    const sql = fs.readFileSync("./migrations/20260421_push_notifications.sql", "utf8");
    await pool.query(sql);
    console.log("✅ Push notifications migration complete");

    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('user_push_tokens', 'notification_preferences')
    `);
    console.log("Tables created:", rows.map(r => r.table_name).join(", "));
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
  } finally {
    await pool.end();
  }
}

runMigration();
