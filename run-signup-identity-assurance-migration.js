import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const root = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260824_signup_identity_assurance.sql";

try {
  await pool.query(readFileSync(join(root, file), "utf8"));
  console.log(`Applied ${file}`);
} catch (err) {
  console.error("Signup identity assurance migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
