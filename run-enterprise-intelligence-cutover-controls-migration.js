import fs from "node:fs";
import path from "node:path";
import pool from "./db.js";

const migrationPath = path.join(
  process.cwd(),
  "migrations",
  "20260624_enterprise_intelligence_cutover_controls.sql"
);

async function run() {
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  console.log("Enterprise intelligence cutover controls migration completed");
}

run()
  .catch((err) => {
    console.error("Enterprise intelligence cutover controls migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
