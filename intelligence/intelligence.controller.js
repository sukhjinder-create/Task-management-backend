import pool from "../db.js";
import { emitWorkspaceIntelligenceUpdate } from "../realtime/socket.js";
import {
  getProfitabilityOracle,
  getResignationRadar,
  getGhostWorkDetection,
  getOrgTruthMap,
} from "./enterpriseIntelligence.service.js";
import {
  bootstrapWorkspaceIntelligence,
  getUnifiedIntelligenceSnapshot,
} from "./engine/unifiedIntelligence.engine.js";
import { resolveCutoverResponse } from "./cutover/sourceSwitch.service.js";
import {
  CORE_CUTOVER_SURFACES,
  CUTOVER_MODES,
  listEnterpriseIntelligenceCutoverControls,
  resolveEnterpriseIntelligenceCutoverPolicy,
  upsertEnterpriseIntelligenceCutoverControl,
} from "./cutover/enterpriseIntelligenceCutover.policy.js";
import { getEnterpriseIntelligenceCutoverDiagnostics } from "./cutover/cutoverDiagnostics.service.js";
import {
  getLegacyAdminInsightsResponse,
  getLegacyCoachingEffectivenessResponse,
  getLegacyProjectsHealthResponse,
  getLegacyTeamComparisonResponse,
  getLegacyUserPerformanceResponse,
  getLegacyUserProjectPerformanceResponse,
  getLegacyUserTrendResponse,
  getLegacyWorkspaceDashboardResponse,
  getLegacyWorkspaceHealthResponse,
} from "./legacy/legacyIntelligence.adapter.js";
import {
  buildAdminInsightsResponse,
  buildCoachingEffectivenessResponse,
  buildExecutiveSummaryData,
  buildProjectsHealthResponse,
  buildTeamComparisonResponse,
  buildUnifiedHistoryResponse,
  buildUserPerformanceResponse,
  buildUserProjectPerformanceResponse,
  buildUserTrendResponse,
  buildWorkspaceDashboardResponse,
  buildWorkspaceHealthResponse,
  computeGoalWorkspaceHealth,
} from "./analytics/intelligenceResponses.service.js";
import { withLegacyIsolation } from "./analytics/cutoverIsolation.service.js";
import { getDashboardExecutiveDetailFromIntelligence } from "./analytics/unifiedDashboard.adapter.js";
import { verifyDashboardHistoryMaterialization } from "./analytics/dashboardHistoryVerification.service.js";
import { backfillDashboardIntelligenceHistory } from "./snapshots/historicalBackfill.service.js";
import {
  getWorkspaceScoringConfig,
  upsertWorkspaceScoringConfig,
} from "./repositories/scoringConfig.repository.js";

function internalServiceAuthorized(req) {
  const expected = process.env.AI_SERVICE_SECRET || process.env.INTERNAL_SERVICE_SECRET || "";
  if (!expected) return false;
  const authorization = req.get("authorization") || "";
  const provided =
    authorization.replace(/^Bearer\s+/i, "") ||
    req.get("x-ai-service-secret") ||
    req.get("x-internal-service-secret") ||
    req.body?.secret ||
    "";
  return provided === expected;
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readDays(value) {
  if (String(value || "").toLowerCase() === "all") return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isWorkspaceAdminRole(role) {
  return [
    "admin",
    "owner",
    "workspace_admin",
    "super_admin",
    "platform_admin",
    "superadmin",
  ].includes(String(role || "").toLowerCase());
}

async function canManageWorkspaceScoring(req) {
  if (isWorkspaceAdminRole(req.user?.role)) return true;
  if (isWorkspaceAdminRole(req.workspaceRole)) return true;

  const { rows } = await pool.query(
    `SELECT role
     FROM workspace_users
     WHERE workspace_id = $1 AND user_id = $2
     LIMIT 1`,
    [req.workspaceId, req.user?.id]
  );
  return isWorkspaceAdminRole(rows[0]?.role);
}

export async function materializeDashboardHistoryInternal(req, res) {
  try {
    if (!internalServiceAuthorized(req)) {
      return res.status(403).json({ error: "Internal service authorization required" });
    }

    const body = req.body || {};
    const workspaceId = body.workspaceId || null;
    const result = await backfillDashboardIntelligenceHistory({
      workspaceId,
      days: readDays(body.days ?? "all"),
      intervalDays: readPositiveNumber(body.intervalDays, 7),
      maxAnchors: readPositiveNumber(body.maxAnchors, 96),
      windowDays: readPositiveNumber(body.windowDays, 30),
      execute: true,
    });

    const verification = body.verify === false
      ? null
      : await verifyDashboardHistoryMaterialization({
        workspaceId,
        limit: readPositiveNumber(body.verifyLimit, 3),
      });
    const failed = verification?.status === "failed";

    return res.status(failed && body.strict !== false ? 500 : 200).json({
      source: "enterprise_intelligence_dashboard_history_materialization",
      status: failed ? "verification_failed" : "executed",
      result,
      verification,
    });
  } catch (err) {
    console.error("materializeDashboardHistoryInternal error:", err);
    return res.status(500).json({
      error: err.message || "Failed to materialize dashboard intelligence history",
      code: err.code || null,
    });
  }
}

/**
 * USER — Monthly performance
 */
export async function getUserPerformance(req, res) {
  try {
    const data = await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "user_performance",
      res,
      unified: () => buildUserPerformanceResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
        month: req.query.month,
      }),
      legacy: () => getLegacyUserPerformanceResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        month: req.query.month,
      }),
    });
    if (!data) {
      return res.status(404).json({ error: "No intelligence profile available for user" });
    }
    return res.json(data);
  } catch (err) {
    console.error("getUserPerformance error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to fetch user performance" });
  }
}

/**
 * ADMIN — Organization insights
 * ✅ AUTHORITATIVE aggregation (no stub)
 */
export async function getAdminInsights(req, res) {
  try {
    const { month, range } = req.query;

    if (!month) {
      return res.status(400).json({ error: "month is required (YYYY-MM)" });
    }

    return res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "admin_insights",
      res,
      unified: () => buildAdminInsightsResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
        range,
      }),
      legacy: () => getLegacyAdminInsightsResponse({
        workspaceId: req.workspaceId,
        month,
      }),
    }));
  } catch (err) {
    console.error("getAdminInsights error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to fetch admin insights" });
  }
}

// ─── GOAL WORKSPACE HEALTH (used by intelligence layer & executive summary) ────
export async function getGoalWorkspaceHealth(req, res) {
  try {
    const { workspaceId } = req;
    const goalsHealth = await computeGoalWorkspaceHealth(workspaceId);
    return res.json(withLegacyIsolation(goalsHealth, {
      surface: "okr_goal_health",
      reason: "OKR pace health is a goal-module signal and is excluded from core enterprise intelligence cutover authority.",
      replacement: "enterprise workspace/project/user intelligence for dashboard performance scoring",
    }));
  } catch (err) {
    console.error("getGoalWorkspaceHealth error:", err);
    res.status(500).json({ error: "Failed to fetch goals health" });
  }
}

/**
 * ADMIN — Executive summary
 */
export async function getExecutiveSummary(req, res) {
  try {
    const workspaceId = req.workspaceId;
    const month = req.query.month;
    const range = req.query.range || "30d";

    if (!month) {
      return res.status(400).json({ error: "month is required (YYYY-MM)" });
    }

    const detail = await getDashboardExecutiveDetailFromIntelligence({
      workspaceId,
      userId: req.user.id,
      role: req.user.role,
      range,
    });

    return res.json({
      month,
      dashboardRange: detail.dashboardRange,
      status: "ready",
      text: detail.fullSummary,
      reasoning: detail.reasoning,
      outlook: detail.reflectiveSummary?.outlook || null,
      reflectiveSummary: detail.reflectiveSummary,
      forecast: detail.forecast,
      summaryPersistence: detail.summaryPersistence,
      summaryBucket: detail.summaryBucket,
    });

    const data = await buildExecutiveSummaryData({
      workspaceId,
      userId: req.user.id,
      role: req.user.role,
      month,
      range,
    });

    // ===== Check existing summary =====
    const existing = await pool.query(`
  SELECT summary, source_data
  FROM workspace_executive_summaries
  WHERE workspace_id = $1
    AND period = $2
  LIMIT 1
`, [workspaceId, month]);

    if (existing.rows.length > 0) {
  const row = existing.rows[0];
  const cachedRange = row.source_data?.dashboardRange?.value || "30d";
  const cacheMatchesRange = cachedRange === data.dashboardRange?.value;

  // ✅ Already generated
  if (
  row.summary &&
  row.summary !== "GENERATING" &&
  row.summary.length > 20 &&
  cacheMatchesRange
) {
    return res.json({
      month,
      dashboardRange: data.dashboardRange,
      status: "ready",
      text: row.summary,
      reasoning: row.source_data?.reasoning || null,
      outlook: row.source_data?.outlook || null
    });
  }

  // ✅ Generation already running
  if (row.source_data?.processing === true && cacheMatchesRange) {
    return res.json({
      month,
      dashboardRange: data.dashboardRange,
      status: "processing",
      text: null
    });
  }

  console.log("Starting AI generation (lock acquired)");

  // 🔒 mark processing true
  await pool.query(`
    UPDATE workspace_executive_summaries
    SET source_data = jsonb_set(
      jsonb_set(COALESCE(source_data, '{}'::jsonb), '{processing}', 'true'),
      '{dashboardRange}',
      $3::jsonb
    )
    WHERE workspace_id = $1 AND period = $2
  `, [workspaceId, month, JSON.stringify(data.dashboardRange || null)]);

  res.json({
    month,
    dashboardRange: data.dashboardRange,
    status: "processing",
    text: null
  });

  setImmediate(async () => {
    try {
      const result = await generateExecutiveSummary(data);

      await saveExecutiveSummary({
        workspaceId,
        period: month,
        summary: result.text,
        sourceData: {
          reasoning: result.reasoning,
          outlook: result.outlook,
          dashboardRange: data.dashboardRange,
          processing: false,
          isFallback: result.isFallback
        }
      });

      console.log("Executive summary stored for", month);

    } catch (err) {
      console.error("Executive summary failed:", err.message);
    }
  });

  return;
}

// ✅ create processing lock so polling does NOT start new jobs
await pool.query(`
INSERT INTO workspace_executive_summaries
(workspace_id, period, summary, source_data)
VALUES (
  $1,
  $2,
  'GENERATING',
  $3::jsonb
)
ON CONFLICT (workspace_id, period) DO NOTHING
`, [workspaceId, month, JSON.stringify({ processing: true, dashboardRange: data.dashboardRange })]);

    // ===== Respond immediately =====
    res.json({
      month,
      dashboardRange: data.dashboardRange,
      status: "processing",
      text: null
    });

    setImmediate(async () => {
  try {
    console.log("Starting AI generation (new record)");

    const result = await generateExecutiveSummary(data);

    await saveExecutiveSummary({
      workspaceId,
      period: month,
      summary: result.text,
      sourceData: {
        reasoning: result.reasoning,
        outlook: result.outlook,
        dashboardRange: data.dashboardRange,
        processing: false,
        isFallback: result.isFallback
      }
    });

    console.log("Executive summary stored for", month);

  } catch (err) {
    console.error("Executive summary generation failed:", err.message);
  }
});

  } catch (err) {
    console.error("getExecutiveSummary error:", err);
    res.status(500).json({ error: "Failed to generate summary" });
  }
}

/**
 * ADMIN — Coaching effectiveness insights
 */
export async function getCoachingEffectiveness(req, res) {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    return res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "coaching_effectiveness",
      res,
      unified: () => buildCoachingEffectivenessResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
        month: req.query.month,
      }),
      legacy: () => getLegacyCoachingEffectivenessResponse({
        workspaceId: req.workspaceId,
        month: req.query.month,
      }),
    }));
  } catch (err) {
    console.error("getCoachingEffectiveness error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to fetch coaching effectiveness" });
  }
}

/**
 * ADMIN — Manual monthly scoring trigger
 */
export async function runMonthlyScoring(req, res) {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { workspaceId } = req;
    const { month } = req.body;

    if (!month) {
      return res.status(400).json({ error: "month is required (YYYY-MM)" });
    }

    const result = await bootstrapWorkspaceIntelligence({
      workspaceId,
      windowDays: 30,
    });

    emitWorkspaceIntelligenceUpdate(workspaceId, {
      type: "enterprise-intelligence-refreshed",
      month,
    });

    return res.json({
      message: "Enterprise intelligence refreshed",
      result: {
        workspace: result.workspace,
        users: result.users.length,
        projects: result.projects.length,
        teams: result.teams.length,
      },
    });
  } catch (err) {
    console.error("Manual scoring error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to refresh enterprise intelligence" });
  }
}

export async function getUnifiedSnapshot(req, res) {
  try {
    const snapshot = await getUnifiedIntelligenceSnapshot({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });

    return res.json({
      source: "enterprise_intelligence",
      ...snapshot,
    });
  } catch (err) {
    console.error("getUnifiedSnapshot error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to fetch unified intelligence snapshot" });
  }
}

export async function getUnifiedHistory(req, res) {
  try {
    const scopeType = String(req.query.scopeType || (req.user.role === "admin" ? "workspace" : "user"));
    const subjectKey = String(
      req.query.subjectKey ||
      (scopeType === "workspace" ? req.workspaceId : req.user.id)
    );

    if (scopeType === "user" && req.user.role !== "admin" && subjectKey !== String(req.user.id)) {
      return res.status(403).json({ error: "Not allowed to view this user history" });
    }
    if (scopeType === "workspace" && req.user.role !== "admin") {
      return res.status(403).json({ error: "Workspace history requires admin access" });
    }

    return res.json(await buildUnifiedHistoryResponse({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      scopeType,
      subjectKey,
      range: req.query.range || "30d",
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    }));
  } catch (err) {
    console.error("getUnifiedHistory error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to fetch unified intelligence history" });
  }
}

export async function getCutoverStatus(req, res) {
  try {
    if (!["admin", "super_admin", "platform_admin"].includes(req.user.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const controls = await listEnterpriseIntelligenceCutoverControls({
      workspaceId: req.workspaceId,
    });
    const policies = await Promise.all(
      CORE_CUTOVER_SURFACES.map(async (surface) => resolveEnterpriseIntelligenceCutoverPolicy({
        workspaceId: req.workspaceId,
        surface,
      }))
    );

    return res.json({
      source: "enterprise_intelligence_cutover_controls",
      workspaceId: req.workspaceId,
      modes: [
        CUTOVER_MODES.LEGACY,
        CUTOVER_MODES.SHADOW,
        CUTOVER_MODES.UNIFIED,
      ],
      defaultMode: controls.defaultMode,
      controls: controls.controls,
      policies,
      rollback: {
        supported: true,
        action: "Set the affected surface or all_core to legacy.",
      },
    });
  } catch (err) {
    console.error("getCutoverStatus error:", err);
    const status = err?.code === "INTELLIGENCE_CUTOVER_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to fetch intelligence cutover status" });
  }
}

export async function getCutoverHealth(req, res) {
  try {
    if (!["admin", "super_admin", "platform_admin"].includes(req.user.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    return res.json(await getEnterpriseIntelligenceCutoverDiagnostics({
      workspaceId: req.workspaceId,
    }));
  } catch (err) {
    console.error("getCutoverHealth error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch intelligence cutover health" });
  }
}

export async function updateCutoverControl(req, res) {
  try {
    if (!["admin", "super_admin", "platform_admin"].includes(req.user.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { surface, mode, reason, metadata, global } = req.body || {};
    if (!surface || !mode) {
      return res.status(400).json({ error: "surface and mode are required" });
    }

    const globalAllowed = ["super_admin", "platform_admin"].includes(req.user.role);
    if (global === true && !globalAllowed) {
      return res.status(403).json({ error: "Global cutover controls require platform admin access" });
    }

    const control = await upsertEnterpriseIntelligenceCutoverControl({
      workspaceId: req.workspaceId,
      surface,
      mode,
      reason: reason || null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      updatedBy: req.user.id,
      global: global === true,
    });

    const policy = await resolveEnterpriseIntelligenceCutoverPolicy({
      workspaceId: req.workspaceId,
      surface: surface === "all_core" ? "dashboard_overview" : surface,
    });

    return res.json({
      source: "enterprise_intelligence_cutover_controls",
      control,
      effectivePolicy: policy,
    });
  } catch (err) {
    console.error("updateCutoverControl error:", err);
    const status = err?.code === "INVALID_CUTOVER_SURFACE" || err?.code === "INVALID_CUTOVER_MODE"
      ? 400
      : err?.code === "INTELLIGENCE_CUTOVER_SCHEMA_MISSING"
        ? 503
        : 500;
    res.status(status).json({ error: err.message || "Failed to update intelligence cutover control" });
  }
}

export async function getScoringConfig(req, res) {
  try {
    if (!(await canManageWorkspaceScoring(req))) {
      return res.status(403).json({ error: "Workspace admin access required" });
    }

    const config = await getWorkspaceScoringConfig({ workspaceId: req.workspaceId });
    return res.json({
      source: "enterprise_intelligence_scoring_config",
      config,
    });
  } catch (err) {
    console.error("getScoringConfig error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch scoring configuration" });
  }
}

export async function updateScoringConfig(req, res) {
  try {
    if (!(await canManageWorkspaceScoring(req))) {
      return res.status(403).json({ error: "Workspace admin access required" });
    }

    const patch = req.body && typeof req.body === "object" ? req.body : {};
    const config = await upsertWorkspaceScoringConfig({
      workspaceId: req.workspaceId,
      patch,
      updatedBy: req.user.id,
    });
    const recalculation = await bootstrapWorkspaceIntelligence({
      workspaceId: req.workspaceId,
      windowDays: 30,
    });

    emitWorkspaceIntelligenceUpdate(req.workspaceId, {
      type: "enterprise-intelligence-scoring-config-updated",
      reason: "workspace_scoring_config_updated",
      configVersion: config.version,
    });

    return res.json({
      source: "enterprise_intelligence_scoring_config",
      config,
      recalculation: {
        workspaceScore: recalculation.workspace?.score ?? null,
        users: recalculation.users.length,
        projects: recalculation.projects.length,
        teams: recalculation.teams.length,
      },
    });
  } catch (err) {
    console.error("updateScoringConfig error:", err);
    res.status(500).json({ error: err.message || "Failed to update scoring configuration" });
  }
}

export async function getUserTrend(req, res) {
  try {
    res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "user_trend",
      res,
      unified: () => buildUserTrendResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
        range: req.query.range,
      }),
      legacy: () => getLegacyUserTrendResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
      }),
    }));
  } catch (err) {
    console.error(err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to get trend" });
  }
}

export async function getUserProjectPerformance(req, res) {
  try {
    res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "user_project_performance",
      res,
      unified: () => buildUserProjectPerformanceResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
      }),
      legacy: () => getLegacyUserProjectPerformanceResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
      }),
    }));
  } catch (err) {
    console.error(err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to get project performance" });
  }
}

/**
 * ADMIN — Per-project health scores
 */
export async function getProjectsHealth(req, res) {
  try {
    return res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "projects_health",
      res,
      unified: () => buildProjectsHealthResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
      }),
      legacy: () => getLegacyProjectsHealthResponse({
        workspaceId: req.workspaceId,
        month: req.query.month,
      }),
    }));
  } catch (err) {
    console.error('getProjectsHealth error:', err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || 'Failed to fetch projects health' });
  }
}

/**
 * ADMIN — Team performance comparison
 */
export async function getTeamComparison(req, res) {
  try {
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    }

    return res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "team_comparison",
      res,
      unified: () => buildTeamComparisonResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
        month,
      }),
      legacy: () => getLegacyTeamComparisonResponse({
        workspaceId: req.workspaceId,
        month,
      }),
    }));
  } catch (err) {
    console.error('getTeamComparison error:', err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || 'Failed to fetch team comparison' });
  }
}

/**
 * ADMIN/ALL — Proactive workspace dashboard
 * Returns aggregated real-time health without requiring a question
 */
export async function getWorkspaceDashboard(req, res) {
  try {
    return res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "workspace_dashboard",
      res,
      unified: () => buildWorkspaceDashboardResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
      }),
      legacy: () => getLegacyWorkspaceDashboardResponse({
        workspaceId: req.workspaceId,
      }),
    }));
  } catch (err) {
    console.error('getWorkspaceDashboard error:', err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({ error: err.message || 'Failed to fetch workspace dashboard' });
  }
}

/**
 * WORKSPACE — Health Pulse
 * Returns current workspace health score
 */
export async function getWorkspaceHealth(req, res) {
  try {
    return res.json(await resolveCutoverResponse({
      workspaceId: req.workspaceId,
      surface: "workspace_health",
      res,
      unified: () => buildWorkspaceHealthResponse({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        role: req.user.role,
      }),
      legacy: () => getLegacyWorkspaceHealthResponse({
        workspaceId: req.workspaceId,
      }),
    }));
  } catch (err) {
    console.error("getWorkspaceHealth error:", err);
    const status = err?.code === "INTELLIGENCE_SCHEMA_MISSING" ? 503 : 500;
    res.status(status).json({
      error: err.message || "Failed to fetch workspace health"
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Enterprise Intelligence Controllers
// ─────────────────────────────────────────────────────────────────────────────

export async function getProfitabilityOracleController(req, res) {
  try {
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ error: "Admin or manager access required" });
    }
    const data = await getProfitabilityOracle(req.workspaceId);
    res.json(withLegacyIsolation(data, {
      surface: "enterprise_specialty_profitability_oracle",
      reason: "Specialty profitability analytics use direct project/task heuristics and are not authoritative enterprise performance scores.",
      replacement: "project_intelligence and workspace_intelligence",
    }));
  } catch (err) {
    console.error("getProfitabilityOracle error:", err);
    res.status(500).json({ error: "Failed to compute profitability oracle" });
  }
}

export async function getResignationRadarController(req, res) {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    const data = await getResignationRadar(req.workspaceId);
    res.json(withLegacyIsolation(data, {
      surface: "enterprise_specialty_resignation_radar",
      reason: "Specialty retention analytics use direct attendance/task/comment heuristics and are not authoritative enterprise performance scores.",
      replacement: "user_intelligence risk and work sustainability indicators",
    }));
  } catch (err) {
    console.error("getResignationRadar error:", err);
    res.status(500).json({ error: "Failed to compute resignation radar" });
  }
}

export async function getGhostWorkController(req, res) {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    const data = await getGhostWorkDetection(req.workspaceId);
    res.json(withLegacyIsolation(data, {
      surface: "enterprise_specialty_ghost_work",
      reason: "Specialty integrity analytics use direct attendance/output heuristics and are not authoritative enterprise performance scores.",
      replacement: "user_intelligence delivery, attendance, and sustainability indicators",
    }));
  } catch (err) {
    console.error("getGhostWorkDetection error:", err);
    res.status(500).json({ error: "Failed to run ghost work detection" });
  }
}

export async function getOrgTruthMapController(req, res) {
  try {
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res.status(403).json({ error: "Admin or manager access required" });
    }
    const data = await getOrgTruthMap(req.workspaceId);
    res.json(withLegacyIsolation(data, {
      surface: "enterprise_specialty_org_truth_map",
      reason: "Specialty organizational archetype analytics use direct collaboration/output heuristics and are excluded from core dashboard scoring authority.",
      replacement: "team_intelligence and workspace_intelligence",
    }));
  } catch (err) {
    console.error("getOrgTruthMap error:", err);
    res.status(500).json({ error: "Failed to compute org truth map" });
  }
}

