// scripts/verify-rls.js
//
// Asserts that EVERY table in the live database has Row Level Security.
//
// tests/migrations-rls-guard.test.js catches a missing RLS statement in a
// migration, which is where the mistake is made. This is the other half: it
// checks the database as it actually is. The two catch different things —
// a table can exist in production without any migration in this repo having
// created it (created by hand, by an older repo, or by a tool), and a migration
// can be correct but never applied.
//
// Exits non-zero when anything is unprotected, so it can be wired into an
// uptime/health job and become an alert rather than a discovery.
//
//   node scripts/verify-rls.js            # report and exit 1 on any gap
//   node scripts/verify-rls.js --json     # machine-readable

import pool from "../db.js";

const asJson = process.argv.includes("--json");

const QUERY = `
  SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
  ORDER BY c.relname
`;

async function main() {
  const { rows } = await pool.query(QUERY);
  const unprotected = rows.filter((r) => !r.rls_enabled).map((r) => r.table_name);
  const total = rows.length;
  const protectedCount = total - unprotected.length;

  if (asJson) {
    console.log(JSON.stringify({ total, protected: protectedCount, unprotected }, null, 2));
  } else if (unprotected.length === 0) {
    console.log(`RLS OK — ${protectedCount}/${total} public tables protected.`);
  } else {
    console.error(`RLS GAP — ${unprotected.length} of ${total} public tables are UNPROTECTED:`);
    for (const name of unprotected) console.error(`  ${name}`);
    console.error("");
    console.error("Each of these is readable through Supabase's public REST API by anyone");
    console.error("holding an anon or authenticated key, bypassing the backend entirely.");
    console.error("Fix with, in a migration:");
    console.error("  ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;");
  }

  await pool.end().catch(() => {});
  process.exit(unprotected.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("verify-rls failed:", err.message);
  await pool.end().catch(() => {});
  process.exit(2);
});
