import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  __dirname,
  "migrations",
  "20260819_blog_publishing.sql"
);

async function run() {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Blog publishing migration applied");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error("Blog publishing migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
