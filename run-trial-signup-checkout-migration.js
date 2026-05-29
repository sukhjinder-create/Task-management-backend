import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260529_trial_signup_stripe_checkout.sql";

try {
  console.log("Running trial signup checkout migration...");
  const sql = readFileSync(join(__dirname, file), "utf8");
  await pool.query(sql);
  console.log(`Applied ${file}`);
} catch (err) {
  console.error("Trial signup checkout migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
