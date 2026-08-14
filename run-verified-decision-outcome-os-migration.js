import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260814_verified_decision_outcome_os.sql";

try {
  await pool.query(readFileSync(join(currentDir, file), "utf8"));
  console.log(`Applied ${file}`);
} catch (error) {
  console.error("Verified decision-to-outcome migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
