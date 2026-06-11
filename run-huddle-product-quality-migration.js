import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.join(
  __dirname,
  "migrations",
  "20260611_huddle_product_quality.sql"
);

async function run() {
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  console.log("Huddle product-quality migration applied");
}

run()
  .catch((error) => {
    console.error("Huddle product-quality migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
