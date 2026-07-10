// ai-platform/policy/policyEngine.js
//
// Centralized enforcement point. In Phase 1 this enforces provider allow/block
// lists and hard budget limits IF (and only if) an administrator has configured
// them. With no policy/budget rows present — the state immediately after
// migration — every request is allowed, so enabling the platform introduces no
// new denials (no regression). Enforcement tightens purely by configuration.

import pool from "../../db.js";

let policyTables = null;

async function hasPolicyTables() {
  if (policyTables !== null) return policyTables;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('ai_policies','ai_budgets','ai_request_logs')`
    );
    policyTables = (rows?.[0]?.n || 0) >= 1;
  } catch {
    policyTables = false;
  }
  return policyTables;
}

/**
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function checkPolicies({ workspaceId, providerKey /*, capabilityKey */ }) {
  try {
    if (!(await hasPolicyTables())) return { allowed: true };

    // Provider allow/block (global + workspace scoped)
    const { rows: policies } = await pool.query(
      `SELECT key, value_json, scope, workspace_id FROM ai_policies
       WHERE enabled = true AND (scope = 'global' OR workspace_id = $1)`,
      [workspaceId ?? null]
    ).catch(() => ({ rows: [] }));

    for (const p of policies) {
      const val = p.value_json || {};
      if (p.key === "blocked_providers" && Array.isArray(val.providers) && val.providers.includes(providerKey)) {
        return { allowed: false, reason: `Provider "${providerKey}" is blocked by policy` };
      }
      if (p.key === "allowed_providers" && Array.isArray(val.providers) && val.providers.length && !val.providers.includes(providerKey)) {
        return { allowed: false, reason: `Provider "${providerKey}" is not in the approved provider list` };
      }
    }

    // Hard budget check — only blocks if a hard_limit budget is configured and exceeded.
    const allowedBudget = await checkHardBudget(workspaceId);
    if (!allowedBudget.allowed) return allowedBudget;

    return { allowed: true };
  } catch (err) {
    // Fail OPEN in Phase 1 so a policy bug can never take AI down. Later phases
    // can make selected policies fail-closed via configuration.
    console.warn("[ai-platform] policy check skipped:", err.message);
    return { allowed: true };
  }
}

async function checkHardBudget(workspaceId) {
  try {
    const { rows: budgets } = await pool.query(
      `SELECT scope, workspace_id, period, limit_cost_usd, limit_tokens FROM ai_budgets
       WHERE hard_limit = true AND enabled = true
         AND (workspace_id = $1 OR (scope='global' AND workspace_id IS NULL))`,
      [workspaceId ?? null]
    ).catch(() => ({ rows: [] }));
    if (!budgets.length) return { allowed: true };

    for (const b of budgets) {
      const since = b.period === "monthly" ? "date_trunc('month', now())" : "date_trunc('day', now())";
      // Workspace budget → that workspace's spend; global budget → platform-wide spend.
      const scopeWs = b.scope === "global" ? null : b.workspace_id;
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(est_cost_usd),0)::numeric AS spent,
                COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0)::bigint AS tokens
           FROM ai_request_logs
          WHERE ($1::text IS NULL OR workspace_id = $1) AND ts >= ${since}`,
        [scopeWs]
      ).catch(() => ({ rows: [{ spent: 0, tokens: 0 }] }));
      const spent = Number(rows?.[0]?.spent || 0);
      const tokens = Number(rows?.[0]?.tokens || 0);
      if (b.limit_cost_usd != null && spent >= Number(b.limit_cost_usd)) {
        return { allowed: false, reason: `AI ${b.period} budget reached ($${Number(b.limit_cost_usd)})` };
      }
      if (b.limit_tokens != null && tokens >= Number(b.limit_tokens)) {
        return { allowed: false, reason: `AI ${b.period} token budget reached (${Number(b.limit_tokens)} tokens)` };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}
