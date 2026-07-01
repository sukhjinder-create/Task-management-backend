import pg from "pg";
import { readFileSync } from "fs";
import { assertDatabaseScriptSafety } from "./utils/databaseSafety.js";

assertDatabaseScriptSafety({ operation: "RLS migration" });

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the RLS migration");
}

const pool = new pg.Pool({
  connectionString,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const sql = readFileSync("./migrations/20260430_enable_rls_all_tables.sql", "utf8");
try {
  await pool.query(sql);
  console.log("RLS enabled on all tables successfully.");
} catch (err) {
  console.error("Migration failed:", err.message);
}
await pool.end();
