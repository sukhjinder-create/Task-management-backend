import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260921_enterprise_completion.sql";

try {
  await pool.query(readFileSync(join(currentDir, file), "utf8"));
  console.log(`Applied ${file}`);
} catch (error) {
  console.error("Enterprise completion migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
