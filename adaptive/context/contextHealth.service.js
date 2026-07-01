import pool from "../../db.js";
import { listContextProviders } from "./contextRegistry.js";

const CONTRACTS = Object.freeze({
  event: {},
  task: { tasks: ["id", "workspace_id", "project_id", "assigned_to", "status", "priority", "due_date"] },
  project: { projects: ["id", "workspace_id", "name"] },
  workspaceMemory: {
    workspace_memory_entries: ["id", "workspace_id", "title", "content", "visibility", "is_archived"],
  },
  workspaceIntelligence: {
    workspace_intelligence: ["workspace_id", "score", "confidence", "risk", "last_evaluated_at"],
    project_intelligence: ["workspace_id", "project_id", "score", "confidence", "risk"],
    team_intelligence: ["workspace_id", "team_key", "manager_id", "score", "confidence"],
  },
  operationalGraph: {
    tasks: ["id", "workspace_id", "project_id", "assigned_to", "sprint_id", "status", "priority", "due_date", "is_blocked"],
    projects: ["id", "workspace_id", "name"],
    task_links: ["workspace_id", "source_task_id", "target_task_id", "link_type"],
    leave_requests: ["workspace_id", "user_id", "start_date", "end_date", "status"],
    attendance_daily: ["workspace_id", "user_id", "date", "available_minutes"],
    operations_ai_actions: ["workspace_id", "capability_key", "confidence", "status", "result"],
    adaptive_learning_signals: ["workspace_id", "scope_type", "scope_id", "signal_key", "status"],
    huddle_meeting_digests: ["workspace_id", "session_id", "digest_json", "provenance_json", "status"],
    okr_objectives: ["workspace_id", "owner_id", "title", "status", "progress"],
    performance_reviews: ["cycle_id", "reviewee_id", "reviewer_id", "status", "overall_score"],
    review_cycles: ["id", "workspace_id"],
    wiki_pages: ["space_id", "title", "content_text", "updated_at"],
    wiki_spaces: ["id", "workspace_id", "name"],
    workspace_digest_runs: ["workspace_id", "digest_type", "summary", "content", "status", "created_at"],
    workspace_executive_summaries: ["workspace_id", "period", "summary", "source_data", "status", "created_at"],
    workspace_events: ["workspace_id", "event_type", "entity_type", "entity_id", "metadata", "occurred_at"],
    workspace_users: ["workspace_id", "user_id", "manager_id", "billing_status"],
    users: ["id", "workspace_id", "role"],
  },
  commandCenter: {
    workspace_execution_signals: ["workspace_id", "source", "signal_type", "metadata"],
    attendance_daily: ["workspace_id", "user_id", "date"],
    leave_requests: ["workspace_id", "user_id", "status"],
  },
});

let latest = null;
let inFlight = null;

async function loadSchema() {
  const { rows } = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  const schema = new Map();
  for (const row of rows) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set());
    schema.get(row.table_name).add(row.column_name);
  }
  return schema;
}

function validateProvider(provider, schema) {
  const contract = CONTRACTS[provider.key];
  if (!contract) {
    return {
      key: provider.key,
      status: "invalid",
      errors: [`No schema contract registered for context provider ${provider.key}`],
    };
  }
  const errors = [];
  for (const [table, columns] of Object.entries(contract)) {
    const available = schema.get(table);
    if (!available) {
      errors.push(`Missing table ${table}`);
      continue;
    }
    const missing = columns.filter((column) => !available.has(column));
    if (missing.length) errors.push(`Missing ${table} column(s): ${missing.join(", ")}`);
  }
  return {
    key: provider.key,
    status: errors.length ? "unavailable" : "available",
    errors,
    checkedTables: Object.keys(contract),
  };
}

export async function validateContextProviderContracts({ force = false } = {}) {
  if (!force && latest && Date.now() - latest.checkedAtMs < 30_000) return latest;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const startedAt = Date.now();
    try {
      await pool.query("SELECT 1");
      const schema = await loadSchema();
      const providers = listContextProviders().map((provider) => validateProvider(provider, schema));
      const unavailable = providers.filter((provider) => provider.status !== "available");
      latest = {
        status: unavailable.length ? "degraded" : "available",
        database: "available",
        providers,
        unavailableProviders: unavailable.map((provider) => provider.key),
        checkedAt: new Date().toISOString(),
        checkedAtMs: Date.now(),
        durationMs: Date.now() - startedAt,
      };
      return latest;
    } catch (error) {
      latest = {
        status: "unavailable",
        database: "unavailable",
        providers: [],
        unavailableProviders: listContextProviders().map((provider) => provider.key),
        error: error?.message || String(error),
        checkedAt: new Date().toISOString(),
        checkedAtMs: Date.now(),
        durationMs: Date.now() - startedAt,
      };
      return latest;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startContextProviderValidation() {
  validateContextProviderContracts({ force: true })
    .then((health) => {
      if (health.status !== "available") {
        console.error("[adaptive-context] Provider validation degraded", health.unavailableProviders);
      }
    })
    .catch((error) => console.error("[adaptive-context] Provider validation failed", error));
}

export function getLatestContextProviderHealth() {
  return latest;
}

export { CONTRACTS as contextProviderContracts };
