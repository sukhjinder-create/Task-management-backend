import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = path.join(root, "migrations", "20260701_adaptive_enterprise_pilot_maturity.sql");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(fs.readFileSync(migration, "utf8"));
  await client.query("COMMIT");
  console.log("Adaptive Enterprise Orchestrator pilot maturity migration applied");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Adaptive Enterprise Orchestrator pilot maturity migration failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
