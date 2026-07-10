// ai-platform/studio/budgets.service.js
//
// Budget management for the AI Studio Cost tab. The ENFORCEMENT lives in
// policy/policyEngine.js (gateway step 2 — hard budgets block requests); this service
// only manages the ai_budgets rows and reports live spend so the UI can show
// "spent / limit". Schema-tolerant + audited.

import { q } from "./db.js";
import { recordAudit } from "./audit.service.js";

async function spendFor({ workspaceId = null, period = "monthly" } = {}) {
  const since = period === "monthly" ? "date_trunc('month', now())" : "date_trunc('day', now())";
  try {
    const { rows } = await q(
      `SELECT COALESCE(SUM(est_cost_usd),0)::numeric AS spent,
              COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0)::bigint AS tokens
         FROM ai_request_logs WHERE ($1::text IS NULL OR workspace_id = $1) AND ts >= ${since}`,
      [workspaceId]
    );
    return { spentUsd: Number(rows?.[0]?.spent || 0), tokens: Number(rows?.[0]?.tokens || 0) };
  } catch { return { spentUsd: 0, tokens: 0 }; }
}

/** All budgets with their live spend for the current period. */
export async function listBudgets() {
  let rows = [];
  try { ({ rows } = await q(`SELECT id, scope, workspace_id, period, limit_cost_usd, limit_tokens, hard_limit, enabled, created_at FROM ai_budgets ORDER BY scope, workspace_id NULLS FIRST, period`)); } catch { rows = []; }
  const out = [];
  for (const r of rows) {
    const spend = await spendFor({ workspaceId: r.scope === "global" ? null : r.workspace_id, period: r.period });
    out.push({
      id: r.id, scope: r.scope, workspaceId: r.workspace_id, period: r.period,
      limitCostUsd: r.limit_cost_usd != null ? Number(r.limit_cost_usd) : null,
      limitTokens: r.limit_tokens != null ? Number(r.limit_tokens) : null,
      hardLimit: r.hard_limit, enabled: r.enabled,
      ...spend,
    });
  }
  return out;
}

/** Create/update the budget for a (scope, workspace, period) — one row per combination. */
export async function upsertBudget({ scope = "workspace", workspaceId = null, period = "monthly", limitCostUsd = null, limitTokens = null, hardLimit = true, enabled = true, actorId = null }) {
  if (scope === "workspace" && !workspaceId) return { ok: false, reason: "workspaceId required for a workspace budget" };
  if (limitCostUsd == null && limitTokens == null) return { ok: false, reason: "set a cost or token limit" };
  const ws = scope === "global" ? null : workspaceId;
  const { rows } = await q(
    `SELECT id FROM ai_budgets WHERE scope = $1 AND (workspace_id = $2 OR ($2::text IS NULL AND workspace_id IS NULL)) AND period = $3 LIMIT 1`,
    [scope, ws, period]
  ).catch(() => ({ rows: [] }));
  if (rows[0]?.id) {
    await q(
      `UPDATE ai_budgets SET limit_cost_usd = $2, limit_tokens = $3, hard_limit = $4, enabled = $5 WHERE id = $1`,
      [rows[0].id, limitCostUsd, limitTokens, Boolean(hardLimit), Boolean(enabled)]
    );
  } else {
    await q(
      `INSERT INTO ai_budgets (scope, workspace_id, period, limit_cost_usd, limit_tokens, hard_limit, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [scope, ws, period, limitCostUsd, limitTokens, Boolean(hardLimit), Boolean(enabled)]
    );
  }
  await recordAudit({ actorType: "superadmin", actorId, action: "upsert", objectType: "budget", objectKey: `${scope}:${ws || "platform"}:${period}`, after: { limitCostUsd, limitTokens, hardLimit, enabled } });
  return { ok: true };
}

export async function deleteBudget({ id, actorId = null }) {
  await q(`DELETE FROM ai_budgets WHERE id = $1`, [id]);
  await recordAudit({ actorType: "superadmin", actorId, action: "delete", objectType: "budget", objectKey: String(id) });
  return { ok: true };
}
