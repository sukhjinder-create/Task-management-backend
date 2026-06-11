import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = [
  "migrations/20260611_huddle_intelligence_worker_framework.sql",
];

const client = await pool.connect();
try {
  for (const file of files) {
    console.log(`Running ${file}...`);
    const sql = readFileSync(join(__dirname, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} catch (error) {
  console.error("Huddle Intelligence worker migration failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
