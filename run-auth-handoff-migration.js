/**
 * Create the auth_handoff_codes table.
 *
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS), so re-running is safe.
 */

import fs from "fs";
import pool from "./db.js";

async function run() {
  const sql = fs.readFileSync("./migrations/20260818_auth_handoff_codes.sql", "utf8");
  await pool.query(sql);

  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'auth_handoff_codes'
      ORDER BY ordinal_position`
  );

  if (!rows.length) throw new Error("auth_handoff_codes was not created");

  console.log("auth_handoff_codes:");
  for (const c of rows) {
    console.log(`  ${c.column_name.padEnd(14)} ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
  }
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("FAILED:", err?.message || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
