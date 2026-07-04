// ai-platform/telemetry/requestLog.js
//
// Best-effort observability. Every gateway execution writes one row to
// ai_request_logs. Logging NEVER throws into the caller — if the table is not
// migrated yet, or the insert fails, the AI request still succeeds. This keeps
// telemetry from ever becoming a regression source.

import pool from "../../db.js";
import { isAiTelemetryEnabled } from "../config/featureFlag.js";

let schemaKnownPresent = null; // null=unknown, true/false=cached

async function tableExists() {
  if (schemaKnownPresent !== null) return schemaKnownPresent;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_request_logs' LIMIT 1`
    );
    schemaKnownPresent = rows.length > 0;
  } catch {
    schemaKnownPresent = false;
  }
  return schemaKnownPresent;
}

/**
 * @param {object} r
 */
export async function logAiRequest(r) {
  try {
    if (!isAiTelemetryEnabled()) return;
    if (!(await tableExists())) return;
    await pool.query(
      `INSERT INTO ai_request_logs
        (workspace_id, capability_key, provider_key, model_key, prompt_key, prompt_version,
         profile_key, latency_ms, input_tokens, output_tokens, est_cost_usd, status,
         failure_reason, retries, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        r.workspaceId ?? null,
        r.capabilityKey ?? null,
        r.providerKey ?? null,
        r.modelKey ?? null,
        r.promptKey ?? null,
        r.promptVersion ?? null,
        r.profileKey ?? null,
        r.latencyMs ?? null,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.estCostUsd ?? null,
        r.status ?? "unknown",
        r.failureReason ? String(r.failureReason).slice(0, 500) : null,
        r.retries ?? 0,
        r.correlationId ?? null,
      ]
    );
  } catch (err) {
    // Never surface telemetry failures to callers.
    console.warn("[ai-platform] telemetry write skipped:", err.message);
  }
}
