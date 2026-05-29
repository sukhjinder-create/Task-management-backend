import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260529_scope_usernames_by_workspace.sql";

try {
  console.log("Running username scope migration...");
  const sql = readFileSync(join(__dirname, file), "utf8");
  await pool.query(sql);
  console.log(`Applied ${file}`);
} catch (err) {
  console.error("Username scope migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
