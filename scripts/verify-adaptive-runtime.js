import fs from "node:fs";
import pool from "../db.js";

process.env.ADAPTIVE_RUNTIME_WORKER_ENABLED = "false";

const requiredTables = [
  "adaptive_runtime_settings",
  "adaptive_event_queue",
  "adaptive_runtime_runs",
  "adaptive_capability_invocations",
  "adaptive_workflow_definitions",
  "adaptive_workflow_runs",
  "adaptive_learning_signals",
  "adaptive_preference_profiles",
  "adaptive_predictions",
];

const requiredOperationsColumns = [
  "adaptive_runtime_run_id",
  "capability_key",
  "approval_mode",
  "correlation_id",
  "idempotency_key",
];

const requiredWorkspaceEventColumns = [
  "schema_version",
  "origin",
  "correlation_id",
  "causation_id",
  "trace_id",
  "occurred_at",
];

function requireRows(label, rows, expected) {
  const found = new Set(rows.map((row) => row.name));
  const missing = expected.filter((name) => !found.has(name));
  if (missing.length) {
    throw new Error(`${label} missing: ${missing.join(", ")}`);
  }
}

async function validateMigrationSql() {
  const sql = fs.readFileSync(new URL("../migrations/20260630_adaptive_agent_runtime.sql", import.meta.url), "utf8");
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

async function main() {
  const { bootstrapAdaptivePlatform } = await import("../adaptive/bootstrap.js");
  const { listCapabilities } = await import("../adaptive/capabilities/capabilityRegistry.js");
  const { listContextProviders } = await import("../adaptive/context/contextRegistry.js");

  await validateMigrationSql();

  const tableResult = await pool.query(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  requireRows("Adaptive runtime tables", tableResult.rows, requiredTables);

  const operationsColumns = await pool.query(
    `SELECT column_name AS name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operations_ai_actions'
       AND column_name = ANY($1::text[])`,
    [requiredOperationsColumns]
  );
  requireRows("operations_ai_actions columns", operationsColumns.rows, requiredOperationsColumns);

  const eventColumns = await pool.query(
    `SELECT column_name AS name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'workspace_events'
       AND column_name = ANY($1::text[])`,
    [requiredWorkspaceEventColumns]
  );
  requireRows("workspace_events columns", eventColumns.rows, requiredWorkspaceEventColumns);

  const bootstrap = bootstrapAdaptivePlatform();
  const capabilities = listCapabilities();
  const providers = listContextProviders();
  const capabilityKeys = new Set(capabilities.map((capability) => capability.key));
  for (const key of ["notification.send", "task.create", "workspace_memory.create", "executive_summary.generate"]) {
    if (!capabilityKeys.has(key)) throw new Error(`Capability not registered: ${key}`);
  }
  if (!providers.some((provider) => provider.key === "task")) {
    throw new Error("Task context provider not registered");
  }

  const result = {
    status: "ok",
    migrationSqlTransactional: true,
    tables: requiredTables.length,
    operationsColumns: requiredOperationsColumns.length,
    workspaceEventColumns: requiredWorkspaceEventColumns.length,
    capabilities: capabilities.length,
    contextProviders: providers.length,
    observers: bootstrap.observers.length,
  };
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error("[verify-adaptive-runtime] failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
