// tests/migrations-rls-guard.test.js
//
// Guards the invariant "every table has Row Level Security" against decay.
//
// Supabase exposes every table over a public REST API. RLS is the only thing
// that stops an anon or authenticated key reading a table directly, bypassing
// the backend and all of its permission middleware. The backend itself is
// unaffected because it connects as the table owner, and owners bypass RLS.
//
// 20260430_enable_rls_all_tables.sql enabled RLS across the database by LISTING
// TABLES BY NAME. That protects the tables that existed that day and nothing
// else, so every table created afterwards arrived unprotected and silently
// stayed that way. By 2026-08-05 that was 85 tables, including meeting
// transcripts, billing rows and the per-entity intelligence tables — none of
// which anyone knew were exposed, because nothing checks.
//
// A migration is where a table is born, so a migration is where this is caught.
// This test is deliberately STATIC: it reads the .sql files and needs no
// database, no credentials and no network, so it can run on every pull request.
//
// If this test fails, the fix is one line in your migration:
//     ALTER TABLE public.<your_table> ENABLE ROW LEVEL SECURITY;

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Tables that intentionally have no RLS. Adding a name here is a deliberate,
 * reviewable decision — which is the point of requiring it to be written down.
 * Empty today: nothing in this database has a reason to be publicly readable.
 */
const EXEMPT = new Set([]);

/** Strip -- line comments and block comments so commented-out SQL is ignored. */
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

function normalizeTableName(raw) {
  return String(raw)
    .trim()
    .replace(/"/g, "")
    .replace(/^public\./i, "")
    .toLowerCase();
}

function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sql: stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")),
    }));
}

// CREATE TABLE [IF NOT EXISTS] [public.]name   — skips TEMP/TEMPORARY tables,
// which live only for a session and are never reachable over the REST API.
const CREATE_TABLE = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi;
const CREATE_TEMP = /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/gi;
const ENABLE_RLS = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;

function collectTables() {
  const created = new Map(); // table -> file that created it
  const protectedTables = new Set();

  for (const { file, sql } of readMigrations()) {
    const tempSpans = [...sql.matchAll(CREATE_TEMP)].map((m) => m.index);

    for (const match of sql.matchAll(CREATE_TABLE)) {
      // A temp-table match starts slightly earlier than the name capture; if a
      // TEMP keyword sits immediately before this match, it is the same statement.
      const isTemp = tempSpans.some((i) => Math.abs(i - match.index) <= 24);
      if (isTemp) continue;
      const name = normalizeTableName(match[1]);
      if (!created.has(name)) created.set(name, file);
    }

    for (const match of sql.matchAll(ENABLE_RLS)) {
      protectedTables.add(normalizeTableName(match[1]));
    }
  }
  return { created, protectedTables };
}

test("migrations exist and are readable", () => {
  const migrations = readMigrations();
  assert.ok(migrations.length > 0, "no .sql migrations found — is the path right?");
});

test("EVERY table created by a migration has RLS enabled somewhere", () => {
  const { created, protectedTables } = collectTables();

  const unprotected = [...created.entries()]
    .filter(([name]) => !protectedTables.has(name) && !EXEMPT.has(name))
    .map(([name, file]) => `  ${name}  (created in ${file})`);

  assert.deepEqual(
    unprotected,
    [],
    unprotected.length
      ? [
          "",
          `${unprotected.length} table(s) are created by a migration but never get RLS:`,
          ...unprotected,
          "",
          "Supabase exposes every table over its public REST API. Without RLS, an",
          "anon or authenticated key can read these directly, bypassing the backend",
          "and all of its permission checks.",
          "",
          "Add this to the migration that creates the table:",
          "  ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;",
          "",
          "The backend is unaffected: it connects as the table owner, and owners",
          "bypass RLS unless FORCE ROW LEVEL SECURITY is set (it is not).",
          "",
          "If a table genuinely must stay world-readable, add it to EXEMPT in",
          "tests/migrations-rls-guard.test.js with a comment explaining why.",
          "",
        ].join("\n")
      : undefined
  );
});

test("the guard actually detects an unprotected table (self-check)", () => {
  // A guard that cannot fail is not a guard. This proves the detection works,
  // so a green run above means something.
  const sql = stripSqlComments(`
    -- CREATE TABLE public.commented_out_should_be_ignored (id int);
    CREATE TABLE IF NOT EXISTS public.widget_thing (id int);
    CREATE TABLE public.gadget_thing (id int);
    ALTER TABLE public.widget_thing ENABLE ROW LEVEL SECURITY;
  `);

  const created = [...sql.matchAll(CREATE_TABLE)].map((m) => normalizeTableName(m[1]));
  const secured = [...sql.matchAll(ENABLE_RLS)].map((m) => normalizeTableName(m[1]));

  assert.ok(created.includes("widget_thing"));
  assert.ok(created.includes("gadget_thing"));
  assert.ok(!created.includes("commented_out_should_be_ignored"), "commented SQL must be ignored");
  assert.deepEqual(created.filter((t) => !secured.includes(t)), ["gadget_thing"]);
});

test("temporary tables are not required to have RLS", () => {
  const sql = stripSqlComments(`CREATE TEMP TABLE scratch_rows (id int);`);
  const tempSpans = [...sql.matchAll(CREATE_TEMP)].map((m) => m.index);
  const flagged = [...sql.matchAll(CREATE_TABLE)].filter(
    (m) => !tempSpans.some((i) => Math.abs(i - m.index) <= 24)
  );
  assert.equal(flagged.length, 0, "a TEMP table is session-scoped and never REST-exposed");
});
