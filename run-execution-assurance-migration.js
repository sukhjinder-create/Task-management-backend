import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260813b_execution_assurance.sql";

try {
  await pool.query(readFileSync(join(currentDir, file), "utf8"));
  console.log(`Applied ${file}`);
} catch (error) {
  console.error("Execution assurance migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
