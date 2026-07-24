import fs from "node:fs";
import assert from "node:assert/strict";
import pool from "../db.js";
import {
  buildEvaluationRecord,
  confidenceCalibrationSummary,
} from "../adaptive/evaluation/adaptiveIntelligenceEvaluation.service.js";

const migrationUrl = new URL("../migrations/20260702_adaptive_intelligence_evaluation_platform.sql", import.meta.url);

const requiredTables = [
  "adaptive_intelligence_evaluations",
  "adaptive_intelligence_metric_snapshots",
];

const requiredEvaluationColumns = [
  "workspace_id",
  "action_id",
  "runtime_run_id",
  "event_id",
  "execution_plan_id",
  "workflow_run_ids",
  "lifecycle",
  "recommendation_category",
  "strategy_summary",
  "capability_summary",
  "context_summary",
  "business_outcomes",
  "confidence_calibration",
  "learning_summary",
  "explainability",
  "effectiveness_score",
  "data_quality",
  "idempotency_key",
];

function requireRows(label, rows, expected) {
  const found = new Set(rows.map((row) => row.name));
  const missing = expected.filter((name) => !found.has(name));
  if (missing.length) {
    throw new Error(`${label} missing: ${missing.join(", ")}`);
  }
}

function validateSqlSafety(sql) {
  const lowered = sql.toLowerCase();
  for (const forbidden of ["drop table", "truncate ", "delete from ", "alter column", "drop column"]) {
    if (lowered.includes(forbidden)) throw new Error(`Migration contains forbidden operation: ${forbidden.trim()}`);
  }
  if (!lowered.includes("create table if not exists adaptive_intelligence_evaluations")) {
    throw new Error("Migration does not create adaptive_intelligence_evaluations idempotently");
  }
  if (!lowered.includes("enable row level security")) {
    throw new Error("Migration does not enable row-level security");
  }
}

async function validateMigrationSql(sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function validateBusinessLanguageContract() {
  const record = buildEvaluationRecord({
    id: "44444444-4444-4444-8444-444444444444",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    status: "executed",
    action_type: "notify_user",
    capability_key: "notification.send",
    summary: "Blocked delivery task needs attention.",
    explanation: "A blocker was detected from meeting and project context.",
    evidence: [{ text: "meeting blocker risk project history" }],
    predictions: [{ status: "evaluated", predicted_value: { probability: 0.8 }, actual_value: { accepted: true }, score: 0.04 }],
    runtime_run: { context_summary: { sources: ["meeting", "risk"] }, reasoning_summary: "Evidence constrained reasoning." },
    learning_signals: [{ signal_key: "prediction.accuracy", source: "continuous_evaluation", status: "active" }],
    workflow_runs: [{ status: "completed" }],
    invocations: [{ capability_key: "notification.send" }],
  });
  assert.ok(record.effectivenessScore >= 0 && record.effectivenessScore <= 1);
  const visible = JSON.stringify({
    recommendationCategory: record.recommendationCategory,
    capabilitySummary: record.capabilitySummary,
    contextSummary: record.contextSummary,
    explainability: record.explainability,
  });
  assert.equal(visible.includes("notification.send"), false);
  assert.equal(visible.includes("prediction.accuracy"), false);

  const calibration = confidenceCalibrationSummary([
    { status: "evaluated", predicted_value: { probability: 0.95 }, actual_value: { accepted: false }, score: 0.9025 },
  ]);
  assert.equal(calibration.falsePositives, 1);
}

async function main() {
  const sql = fs.readFileSync(migrationUrl, "utf8");
  validateSqlSafety(sql);
  await validateMigrationSql(sql);

  const tableResult = await pool.query(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  const foundTables = new Set(tableResult.rows.map((row) => row.name));
  const missingTables = requiredTables.filter((table) => !foundTables.has(table));
  const requireAppliedSchema = process.env.AIEP_REQUIRE_APPLIED_SCHEMA === "true";
  let schemaPresent = missingTables.length === 0;
  let evaluationColumns = 0;

  if (schemaPresent) {
    const columnResult = await pool.query(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'adaptive_intelligence_evaluations'
         AND column_name = ANY($1::text[])`,
      [requiredEvaluationColumns]
    );
    requireRows("adaptive_intelligence_evaluations columns", columnResult.rows, requiredEvaluationColumns);
    evaluationColumns = requiredEvaluationColumns.length;
  } else if (requireAppliedSchema) {
    requireRows("AIEP tables", tableResult.rows, requiredTables);
  }

  validateBusinessLanguageContract();

  console.log(JSON.stringify({
    status: "ok",
    migrationSqlTransactional: true,
    additiveOnly: true,
    schemaPresent,
    missingTables,
    tables: requiredTables.length,
    evaluationColumns,
    businessLanguageContract: true,
  }, null, 2));
}

main()
  .catch((error) => {
    const detail = error.message || error.code || error.name || "unknown error";
    console.error("[verify-adaptive-intelligence-evaluation] failed:", detail);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
