import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260601_razorpay_trial_signup.sql";

try {
  console.log("Running Razorpay trial signup migration...");
  const sql = readFileSync(join(__dirname, file), "utf8");
  await pool.query(sql);
  console.log(`Applied ${file}`);
} catch (err) {
  console.error("Razorpay trial signup migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
