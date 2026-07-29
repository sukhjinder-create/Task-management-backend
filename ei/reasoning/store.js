// ei/reasoning/store.js
//
// EI V2.1 Phase 4 — immutable reasoning-trace store. Append-only, idempotent by
// trace_id. Schema-tolerant. UNVERIFIED AT RUNTIME. Reuses the AI Platform q.

import { q } from "../../ai-platform/studio/db.js";

export async function appendTrace(t) {
  if (!t || !t.traceId || !t.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_reasoning_traces
       (trace_id, workspace_id, trace_version, claim_json, confidence_json, trace_body_json)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (trace_id) DO NOTHING
     RETURNING trace_id`,
    [t.traceId, t.workspaceId, t.traceVersion || 1, JSON.stringify(t.claim || {}), JSON.stringify(t.confidenceDecomposition || {}), JSON.stringify(t)]
  );
  return rows[0]?.trace_id ?? null;
}

export async function listTraces({ workspaceId, limit = 200 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_reasoning_traces WHERE workspace_id = $1 ORDER BY trace_id LIMIT $2`,
    [workspaceId, Math.min(Number(limit) || 200, 1000)]
  );
  return rows;
}
