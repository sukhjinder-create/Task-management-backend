/**
 * migrate-to-supabase.js
 *
 * One-command full database migration:
 *   1. Creates all schema on new Supabase DB (runs every migration file)
 *   2. Copies all data from old DB to new DB
 *   3. Resets all sequences so auto-increment IDs continue correctly
 *
 * Setup:
 *   Add NEW_DATABASE_URL to your .env file (the Supabase pooler connection string)
 *   Then run:  node migrate-to-supabase.js
 */

import "dotenv/config";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Source: your current database ──────────────────────────────────────────
const source = new Pool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:     Number(process.env.DB_PORT) || 5432,
  ssl:      process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
});

// ── Destination: Supabase ───────────────────────────────────────────────────
if (!process.env.NEW_DATABASE_URL) {
  console.error("❌  NEW_DATABASE_URL is not set in your .env file.");
  console.error("    Add it like:  NEW_DATABASE_URL=postgresql://...");
  process.exit(1);
}

const dest = new Pool({
  connectionString: process.env.NEW_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

// ── Helpers ─────────────────────────────────────────────────────────────────
const log  = (msg) => console.log(msg);
const ok   = (msg) => console.log(`  ✅  ${msg}`);
const skip = (msg) => console.log(`  ⏭️   ${msg}`);
const warn = (msg) => console.warn(`  ⚠️   ${msg}`);
const fail = (msg) => console.error(`  ❌  ${msg}`);

// ── Step 1: Run all migration SQL files on new DB ───────────────────────────
async function setupSchema() {
  log("\n━━━  STEP 1: Setting up schema on Supabase  ━━━\n");

  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort(); // alphabetical = chronological given your naming

  log(`Found ${files.length} migration files\n`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      await dest.query(sql);
      ok(file);
    } catch (err) {
      // Most common: table/index already exists — safe to continue
      if (
        err.message.includes("already exists") ||
        err.message.includes("duplicate") ||
        err.code === "42P07" || // duplicate table
        err.code === "42701"    // duplicate column
      ) {
        skip(`${file} (already applied)`);
      } else {
        warn(`${file}: ${err.message}`);
      }
    }
  }
}

// ── Step 2: Copy all data ───────────────────────────────────────────────────
async function copyData() {
  log("\n━━━  STEP 2: Copying all data  ━━━\n");

  // Get tables ordered to respect FK dependencies
  const { rows: tables } = await source.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  log(`Found ${tables.length} tables\n`);

  // Disable FK checks on destination so we can insert in any order
  await dest.query("SET session_replication_role = replica;");

  let totalRows = 0;

  for (const { tablename } of tables) {
    try {
      const { rows: [{ count }] } = await source.query(
        `SELECT COUNT(*) FROM "${tablename}"`
      );
      const rowCount = Number(count);

      if (rowCount === 0) {
        skip(`${tablename}: empty`);
        continue;
      }

      // Clear destination table (safe — FK checks are off)
      await dest.query(`TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE`);

      // Fetch all rows from source
      const { rows } = await source.query(`SELECT * FROM "${tablename}"`);
      if (rows.length === 0) { skip(`${tablename}: empty`); continue; }

      const columns = Object.keys(rows[0]);
      const colList = columns.map(c => `"${c}"`).join(", ");
      const BATCH = 200;

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const values = [];
        const placeholders = batch.map((row, ri) => {
          const rowVals = columns.map((col, ci) => {
            values.push(row[col]);
            return `$${ri * columns.length + ci + 1}`;
          });
          return `(${rowVals.join(", ")})`;
        }).join(", ");

        await dest.query(
          `INSERT INTO "${tablename}" (${colList}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
          values
        );
      }

      ok(`${tablename}: ${rows.length} rows`);
      totalRows += rows.length;

    } catch (err) {
      fail(`${tablename}: ${err.message}`);
    }
  }

  // Re-enable FK checks
  await dest.query("SET session_replication_role = DEFAULT;");
  log(`\n  Total rows migrated: ${totalRows.toLocaleString()}`);
}

// ── Step 3: Reset sequences ─────────────────────────────────────────────────
async function resetSequences() {
  log("\n━━━  STEP 3: Resetting sequences  ━━━\n");

  const { rows: seqs } = await source.query(`
    SELECT sequencename, last_value
    FROM pg_sequences
    WHERE schemaname = 'public'
  `);

  for (const { sequencename, last_value } of seqs) {
    try {
      const val = last_value ?? 1;
      await dest.query(`SELECT setval('${sequencename}', ${val}, true)`);
      ok(`${sequencename} → ${val}`);
    } catch (err) {
      warn(`${sequencename}: ${err.message}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🚀  Asystence Database Migration → Supabase");
  console.log("════════════════════════════════════════════\n");

  try {
    await source.query("SELECT 1");
    ok("Connected to source database");
  } catch (err) {
    fail(`Cannot connect to source DB: ${err.message}`);
    process.exit(1);
  }

  try {
    await dest.query("SELECT 1");
    ok("Connected to Supabase database");
  } catch (err) {
    fail(`Cannot connect to Supabase: ${err.message}`);
    fail("Check your NEW_DATABASE_URL in .env");
    process.exit(1);
  }

  await setupSchema();
  await copyData();
  await resetSequences();

  console.log("\n════════════════════════════════════════════");
  console.log("🎉  Migration complete! Your Supabase DB is ready.");
  console.log("\nNext step: set DATABASE_URL in Railway to your Supabase URL");
  console.log("════════════════════════════════════════════\n");

  await source.end();
  await dest.end();
}

main().catch(err => {
  console.error("\n💥 Fatal:", err.message);
  process.exit(1);
});
