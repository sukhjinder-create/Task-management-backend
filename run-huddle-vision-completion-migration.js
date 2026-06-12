import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  __dirname,
  "migrations",
  "20260612_huddle_vision_completion.sql"
);

const client = await pool.connect();
try {
  const sql = fs.readFileSync(migrationPath, "utf8");
  await client.query(sql);
  console.log("Huddle vision-completion migration applied");
} catch (error) {
  console.error("Huddle vision-completion migration failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
