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
      `SELECT period, limit_cost_usd FROM ai_budgets
       WHERE hard_limit = true AND (workspace_id = $1 OR (scope='global' AND workspace_id IS NULL))`,
      [workspaceId ?? null]
    ).catch(() => ({ rows: [] }));
    if (!budgets.length) return { allowed: true };

    for (const b of budgets) {
      const since = b.period === "monthly" ? "date_trunc('month', now())" : "date_trunc('day', now())";
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(est_cost_usd),0)::numeric AS spent FROM ai_request_logs
         WHERE (workspace_id = $1 OR $1 IS NULL) AND ts >= ${since}`,
        [workspaceId ?? null]
      ).catch(() => ({ rows: [{ spent: 0 }] }));
      const spent = Number(rows?.[0]?.spent || 0);
      if (b.limit_cost_usd != null && spent >= Number(b.limit_cost_usd)) {
        return { allowed: false, reason: `AI ${b.period} budget reached` };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}
