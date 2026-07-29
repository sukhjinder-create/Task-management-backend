// ai-platform/studio/telemetry.service.js
//
// Epic C — telemetry / usage / cost / health reads over ai_request_logs and
// ai_safety_events. Schema-tolerant: returns zeros/empty when the tables are
// absent or the DB is unreachable. UNVERIFIED AT RUNTIME (needs real log data).

import { q } from "./db.js";

const SINCE = { day: "date_trunc('day', now())", month: "date_trunc('month', now())", week: "now() - interval '7 days'", all: "'-infinity'::timestamptz" };

function sinceExpr(period) {
  return SINCE[period] || SINCE.month;
}

export async function getUsage({ workspaceId = null, period = "month" } = {}) {
  const { rows } = await q(
    `SELECT capability_key, provider_key, COUNT(*)::int AS requests,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COUNT(*) FILTER (WHERE status='failure')::int AS failures
       FROM ai_request_logs
      WHERE ts >= ${sinceExpr(period)} AND ($1::text IS NULL OR workspace_id = $1)
      GROUP BY capability_key, provider_key ORDER BY requests DESC`,
    [workspaceId]
  );
  return { period, rows };
}

export async function getCost({ workspaceId = null, period = "month" } = {}) {
  const { rows } = await q(
    `SELECT capability_key, provider_key,
            COALESCE(SUM(est_cost_usd),0)::numeric AS estimated_usd,
            COALESCE(SUM(actual_cost_usd),0)::numeric AS actual_usd,
            COUNT(*)::int AS requests
       FROM ai_request_logs
      WHERE ts >= ${sinceExpr(period)} AND ($1::text IS NULL OR workspace_id = $1)
      GROUP BY capability_key, provider_key ORDER BY actual_usd DESC`,
    [workspaceId]
  );
  const total = rows.reduce((s, r) => s + Number(r.actual_usd || 0), 0);
  return { period, totalActualUsd: Math.round(total * 1e6) / 1e6, rows };
}

export async function getCapabilityHealth({ period = "week" } = {}) {
  const { rows } = await q(
    `SELECT capability_key,
            COUNT(*)::int AS requests,
            ROUND(100.0 * COUNT(*) FILTER (WHERE status='success') / GREATEST(COUNT(*),1), 1) AS success_rate,
            ROUND(AVG(latency_ms)) AS avg_latency_ms
       FROM ai_request_logs WHERE ts >= ${sinceExpr(period)}
      GROUP BY capability_key ORDER BY requests DESC`
  );
  return rows;
}

export async function getProviderHealth({ period = "week" } = {}) {
  const { rows } = await q(
    `SELECT provider_key,
            COUNT(*)::int AS requests,
            ROUND(100.0 * COUNT(*) FILTER (WHERE status='success') / GREATEST(COUNT(*),1), 1) AS success_rate,
            ROUND(AVG(latency_ms)) AS avg_latency_ms,
            COUNT(*) FILTER (WHERE status='failure')::int AS failures
       FROM ai_request_logs WHERE ts >= ${sinceExpr(period)}
      GROUP BY provider_key ORDER BY requests DESC`
  );
  return rows;
}

export async function getRecentTraces({ workspaceId = null, limit = 50 } = {}) {
  const { rows } = await q(
    `SELECT ts, capability_key, provider_key, model_key, status, latency_ms, est_cost_usd,
            trace_id, span_id, parent_span_id, source_module, trigger_type, correlation_id
       FROM ai_request_logs WHERE ($1::text IS NULL OR workspace_id = $1)
      ORDER BY ts DESC LIMIT $2`,
    [workspaceId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}
