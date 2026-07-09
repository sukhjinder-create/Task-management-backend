// run-ewip-v3-migration.js
//
// Applies the additive Enterprise Intelligence (V2.1 waves A–C) + Execution Platform V3
// schema. Every migration is CREATE TABLE/INDEX IF NOT EXISTS — additive & idempotent,
// so re-running is safe. Guarded by the shared database-safety-guard (run via:
//   node --import ./scripts/database-safety-guard.js run-ewip-v3-migration.js
// and, for a production target, ALLOW_PRODUCTION_MIGRATION=true + the confirmation token).

import pg from "pg";
import { readFileSync } from "fs";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");

const pool = new pg.Pool({
  connectionString,
  ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
});

const MIGRATIONS = [
  ["./migrations/20260707_ei_events.sql", "EI Phase 1 — canonical event log"],
  ["./migrations/20260707b_ei_attributions.sql", "EI Phase 2 — attributions"],
  ["./migrations/20260707c_ei_evidence.sql", "EI Phase 3 — evidence"],
  ["./migrations/20260707d_ei_reasoning_traces.sql", "EI Phase 4 — reasoning traces"],
  ["./migrations/20260707e_ei_predictions.sql", "EI Phase 5 — predictions"],
  ["./migrations/20260708a_ei_recommendations.sql", "EI Phase 6 — recommendations"],
  ["./migrations/20260708b_ei_outcomes.sql", "EI Wave C — outcomes ledger"],
  ["./migrations/20260708c_ei_calibration_models.sql", "EI Wave C — calibration models"],
  ["./migrations/20260708d_ei_learning.sql", "EI Wave C — learning proposals + reviews"],
  ["./migrations/20260708e_ei_experiments.sql", "EI Wave C — experiments + assignments"],
  ["./migrations/20260708f_ei_org_memory.sql", "EI Wave C — organizational memory"],
  ["./migrations/20260708g_execution_platform.sql", "Execution Platform V3 — decisions/approvals/executions/workflows/policies/automations/action-log"],
];

let applied = 0, already = 0, failed = 0;
for (const [file, label] of MIGRATIONS) {
  const sql = readFileSync(new URL(file, import.meta.url), "utf8");
  try {
    await pool.query(sql);
    applied += 1;
    console.log(`✓ applied: ${label}`);
  } catch (err) {
    if (/already exists/i.test(err.message)) { already += 1; console.log(`• already applied: ${label}`); }
    else { failed += 1; console.error(`✗ FAILED: ${label} — ${err.message}`); }
  }
}

// Verify the tables exist afterwards.
const EXPECTED_TABLES = [
  "ei_events", "ei_attributions", "ei_evidence", "ei_reasoning_traces", "ei_predictions",
  "ei_recommendations", "ei_outcomes", "ei_calibration_models", "ei_learning_proposals",
  "ei_learning_reviews", "ei_experiments", "ei_experiment_assignments", "ei_org_memory",
  "exec_decisions", "exec_decision_events", "exec_approval_requests", "exec_approval_events",
  "exec_executions", "exec_verifications", "exec_workflow_runs", "exec_policies",
  "exec_automations", "exec_action_log",
];
const { rows } = await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
  [EXPECTED_TABLES]
);
const present = new Set(rows.map((r) => r.table_name));
const missing = EXPECTED_TABLES.filter((t) => !present.has(t));

console.log(`\n[ewip-v3] applied=${applied} already=${already} failed=${failed}`);
console.log(`[ewip-v3] tables present ${present.size}/${EXPECTED_TABLES.length}`);
if (missing.length) console.error(`[ewip-v3] MISSING TABLES: ${missing.join(", ")}`);

await pool.end();
process.exit(failed > 0 || missing.length > 0 ? 1 : 0);
