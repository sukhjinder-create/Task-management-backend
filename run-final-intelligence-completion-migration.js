import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const migration = path.join(root, "migrations", "20260702_final_intelligence_completion.sql");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(fs.readFileSync(migration, "utf8"));
  await client.query("COMMIT");
  console.log("Asystence V1 final intelligence completion migration applied");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Asystence V1 final intelligence completion migration failed:", error.message || error.code || error.name);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
