// ai-platform/telemetry/requestLog.js
//
// Best-effort observability. Every gateway execution writes one row to
// ai_request_logs. Logging NEVER throws into the caller.
//
// P5: adds trace/span/trigger/source-module fields (Contract v2 §12). The INSERT
// is built DYNAMICALLY from the columns that actually exist, so telemetry works
// identically whether or not the P5 migration has been applied (fully
// non-regressive across schema versions).

import pool from "../../db.js";
import { isAiTelemetryEnabled } from "../config/featureFlag.js";

let columnCache = null; // Set<string> | null

async function getColumns() {
  if (columnCache !== null) return columnCache;
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_request_logs'`
    );
    columnCache = new Set(rows.map((r) => r.column_name));
  } catch {
    columnCache = new Set(); // no table / no DB → skip writes
  }
  return columnCache;
}

/** Reset the cached column set (tests / after migration). */
export function _resetColumnCache() {
  columnCache = null;
}

export async function logAiRequest(r) {
  try {
    if (!isAiTelemetryEnabled()) return;
    const columns = await getColumns();
    if (columns.size === 0) return;

    // column → value (only included if the column exists AND value is defined)
    const candidate = {
      workspace_id: r.workspaceId,
      capability_key: r.capabilityKey,
      provider_key: r.providerKey,
      model_key: r.modelKey,
      prompt_key: r.promptKey,
      prompt_version: r.promptVersion,
      profile_key: r.profileKey,
      latency_ms: r.latencyMs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      est_cost_usd: r.estCostUsd,
      actual_cost_usd: r.actualCostUsd,
      status: r.status,
      failure_reason: r.failureReason ? String(r.failureReason).slice(0, 500) : null,
      retries: r.retries,
      correlation_id: r.correlationId,
      // ── P5 (Contract §12) ──
      trace_id: r.traceId,
      span_id: r.spanId,
      parent_span_id: r.parentSpanId,
      source_module: r.sourceModule,
      trigger_type: r.triggerType,
      parent_request_id: r.parentRequestId,
    };

    const cols = [];
    const values = [];
    for (const [col, val] of Object.entries(candidate)) {
      if (val !== undefined && columns.has(col)) {
        cols.push(col);
        values.push(val);
      }
    }
    if (cols.length === 0) return;

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`INSERT INTO ai_request_logs (${cols.join(",")}) VALUES (${placeholders})`, values);
  } catch (err) {
    console.warn("[ai-platform] telemetry write skipped:", err.message);
  }
}
