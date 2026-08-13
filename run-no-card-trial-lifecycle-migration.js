import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const file = "migrations/20260813_no_card_trial_lifecycle.sql";
  await pool.query(readFileSync(join(__dirname, file), "utf8"));
  console.log(`Applied ${file}`);
} catch (err) {
  console.error("No-card trial lifecycle migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
