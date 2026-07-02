import fs from "node:fs";
import assert from "node:assert/strict";
import pool from "../db.js";
import {
  buildCoachInsights,
  buildUniversalExplanation,
  discoverMemoryPatternsFromEvidence,
  evaluateExperimentVariants,
} from "../adaptive/evaluation/finalIntelligenceCompletion.service.js";

const migrationUrl = new URL("../migrations/20260702_final_intelligence_completion.sql", import.meta.url);

const requiredTables = [
  "adaptive_intelligence_coach_insights",
  "adaptive_strategy_experiments",
  "adaptive_strategy_experiment_results",
  "adaptive_memory_patterns",
  "adaptive_universal_explanations",
];

function validateSqlSafety(sql) {
  const lowered = sql.toLowerCase();
  for (const forbidden of ["drop table", "truncate ", "delete from ", "drop column", "alter column"]) {
    if (lowered.includes(forbidden)) throw new Error(`Migration contains forbidden operation: ${forbidden.trim()}`);
  }
  for (const table of requiredTables) {
    if (!lowered.includes(`create table if not exists ${table}`)) {
      throw new Error(`Migration does not create ${table} idempotently`);
    }
  }
  if (!lowered.includes("enable row level security")) {
    throw new Error("Migration does not enable row-level security");
  }
}

async function validateMigrationTransaction(sql) {
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

async function validateSchemaPresence() {
  const { rows } = await pool.query(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  const found = new Set(rows.map((row) => row.name));
  return requiredTables.filter((table) => !found.has(table));
}

function validatePureContracts() {
  const evaluation = {
    recommendation_category: "Meeting follow-through",
    effectiveness_score: 0.8,
    lifecycle: { stages: [{ label: "User response", value: "executed" }] },
    context_summary: [{ label: "Meetings" }],
    capability_summary: [{ label: "Create follow-up work" }],
    confidence_calibration: { evaluated: 1 },
    learning_summary: { learningChanges: ["Prediction accuracy update"] },
    explainability: { whyRecommended: "Meeting outcome needed follow-through.", outcome: "Delivery improved.", predictedConfidence: 0.8, wouldRecommendAgain: true },
  };
  const insights = buildCoachInsights({ currentRecords: [evaluation, evaluation, evaluation], previousRecords: [] });
  assert.ok(insights.length > 0);
  assert.ok(insights.every((item) => item.evidence.length > 0));

  const experiment = evaluateExperimentVariants({
    experiment: {
      variants: [
        { key: "a", label: "Meeting follow-up", filter: { recommendationCategory: "Meeting follow-through" } },
        { key: "b", label: "Reminder notification", filter: { recommendationCategory: "Communication and nudges" } },
      ],
      minimum_sample_size: 3,
      meaningful_delta: 0.08,
    },
    records: [
      evaluation, evaluation, evaluation,
      { ...evaluation, recommendation_category: "Communication and nudges", effectiveness_score: 0.5 },
      { ...evaluation, recommendation_category: "Communication and nudges", effectiveness_score: 0.51 },
      { ...evaluation, recommendation_category: "Communication and nudges", effectiveness_score: 0.52 },
    ],
  });
  assert.equal(experiment.recommendation.meaningfulEvidence, true);

  const patterns = discoverMemoryPatternsFromEvidence({
    evaluations: [
      { ...evaluation, effectiveness_score: 0.3, lifecycle: { stages: [{ label: "User response", value: "rejected" }] } },
      { ...evaluation, effectiveness_score: 0.31, lifecycle: { stages: [{ label: "User response", value: "rejected" }] } },
      { ...evaluation, effectiveness_score: 0.32, lifecycle: { stages: [{ label: "User response", value: "rejected" }] } },
    ],
  });
  assert.ok(patterns.some((pattern) => pattern.direction === "avoid"));

  const explanation = buildUniversalExplanation({
    action: { summary: "Explain delivery risk", explanation: "notification.send recommendation.accepted", confidence: 0.7 },
    evaluation,
  });
  assert.equal(explanation.includes("notification.send"), false);
  assert.equal(explanation.includes("recommendation.accepted"), false);
}

async function main() {
  const sql = fs.readFileSync(migrationUrl, "utf8");
  validateSqlSafety(sql);
  validatePureContracts();
  await validateMigrationTransaction(sql);
  const missingTables = await validateSchemaPresence();
  const schemaPresent = missingTables.length === 0;
  if (!schemaPresent && process.env.FINAL_INTELLIGENCE_REQUIRE_APPLIED_SCHEMA === "true") {
    throw new Error(`Final intelligence schema missing: ${missingTables.join(", ")}`);
  }
  console.log(JSON.stringify({
    status: "ok",
    migrationSqlTransactional: true,
    additiveOnly: true,
    pureContracts: true,
    schemaPresent,
    missingTables,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error("[verify-final-intelligence-completion] failed:", error.message || error.code || error.name);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
