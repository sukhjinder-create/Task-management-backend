import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const file = "migrations/20260902_client_assurance_portal.sql";

try {
  await pool.query(readFileSync(join(currentDir, file), "utf8"));
  console.log(`Applied ${file}`);
} catch (error) {
  console.error("Client assurance portal migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
