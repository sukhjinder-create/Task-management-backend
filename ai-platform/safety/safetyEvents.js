// ai-platform/safety/safetyEvents.js
//
// P7 — best-effort persistence of safety findings to ai_safety_events. Never
// throws into the caller; schema-tolerant like the request-log writer, so it
// works with or without the additive migration. No behavior impact.

import pool from "../../db.js";
import { isAiTelemetryEnabled } from "../config/featureFlag.js";

let tablePresent = null;

async function hasTable() {
  if (tablePresent !== null) return tablePresent;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_safety_events' LIMIT 1`
    );
    tablePresent = rows.length > 0;
  } catch {
    tablePresent = false;
  }
  return tablePresent;
}

export async function recordSafetyEvent(evt) {
  try {
    if (!isAiTelemetryEnabled()) return;
    if (!evt?.findings?.length) return;
    if (!(await hasTable())) return;
    await pool.query(
      `INSERT INTO ai_safety_events
         (workspace_id, capability_key, input_verdict, output_verdict, findings_json, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        evt.workspaceId ?? null,
        evt.capabilityKey ?? null,
        evt.inputVerdict ?? null,
        evt.outputVerdict ?? null,
        JSON.stringify(evt.findings || []),
        evt.correlationId ?? null,
      ]
    );
  } catch (err) {
    console.warn("[ai-platform] safety event write skipped:", err.message);
  }
}
