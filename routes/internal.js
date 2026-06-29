import pool from "../db.js";
import express from "express";
import { createAIChatMessage } from "../services/chat.service.js";
import { getProjectReport } from "../services/reports.service.js";
import { materializeDashboardHistoryInternal } from "../intelligence/intelligence.controller.js";
import {
  buildProjectsHealthResponse,
  buildTeamComparisonResponse,
  buildUserPerformanceResponse,
  buildUserProjectPerformanceResponse,
  buildUserTrendResponse,
  buildWorkspaceHealthResponse,
} from "../intelligence/analytics/intelligenceResponses.service.js";
import { getDashboardOverviewFromIntelligence } from "../intelligence/analytics/unifiedDashboard.adapter.js";
import { certifyEnterpriseIntelligenceCoreWorkspace } from "../intelligence/certification/coreCertification.service.js";
import { traceUserScoreForWorkspace } from "../intelligence/certification/userScoreTrace.service.js";
import { PERIOD_EXECUTIVE_SUMMARY_VERSION } from "../intelligence/analytics/periodExecutiveSummary.service.js";
import { bootstrapWorkspaceIntelligence } from "../intelligence/engine/unifiedIntelligence.engine.js";
import {
  getWorkspaceScoringConfig,
  upsertWorkspaceScoringConfig,
} from "../intelligence/repositories/scoringConfig.repository.js";
import { adminScoringConfigSurface } from "../intelligence/config/scoringConfig.model.js";

console.log("🔥 INTERNAL ROUTES LOADED");

const router = express.Router();
const EXECUTIVE_SUMMARY_VALIDATION_RANGES = Object.freeze(["30d", "90d", "6m", "1y", "all"]);

router.post("/dashboard-history/materialize", materializeDashboardHistoryInternal);

function internalToken(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function internalSecretMatches(req) {
  const expected = process.env.INTERNAL_SERVICE_SECRET || process.env.AI_SERVICE_SECRET || "";
  const provided =
    internalToken(req) ||
    req.headers["x-internal-service-secret"] ||
    req.headers["x-ai-service-secret"] ||
    req.body?.secret ||
    "";
  return Boolean(expected && provided === expected);
}

async function findInternalWorkspaceAdmin(workspaceId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, role
     FROM users
     WHERE workspace_id = $1
       AND COALESCE(is_system, false) = false
       AND COALESCE(role, '') IN ('admin', 'manager', 'user')
     ORDER BY
       CASE WHEN role = 'admin' THEN 0
            WHEN role = 'manager' THEN 1
            ELSE 2 END,
       created_at ASC
     LIMIT 1`,
    [workspaceId]
  );
  return rows[0] || null;
}

async function resolveInternalWorkspace({ workspaceId = null, workspaceName = null } = {}) {
  if (workspaceId) {
    const { rows } = await pool.query(
      `SELECT id, name
       FROM workspaces
       WHERE id = $1
       LIMIT 1`,
      [workspaceId]
    );
    if (rows[0]) return rows[0];
  }
  if (workspaceName) {
    const { rows } = await pool.query(
      `SELECT id, name
       FROM workspaces
       WHERE LOWER(name) = LOWER($1)
          OR name ILIKE $2
       ORDER BY CASE WHEN LOWER(name) = LOWER($1) THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
      [workspaceName, `%${workspaceName}%`]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

function tooltipContractStatus(tooltip = {}) {
  const missing = [];
  if (!tooltip.authority) missing.push("authority");
  if (!tooltip.formula) missing.push("formula");
  if (!Array.isArray(tooltip.normalizedInputs)) missing.push("normalizedInputs");
  if (!Array.isArray(tooltip.weightedContribution)) missing.push("weightedContribution");
  if (tooltip.confidence == null) missing.push("confidence");
  if (!Object.prototype.hasOwnProperty.call(tooltip, "lastRecalculated")) missing.push("lastRecalculated");
  if (!tooltip.coveragePeriod) missing.push("coveragePeriod");
  return {
    passed: missing.length === 0,
    missing,
  };
}

function traceContractStatus(trace = {}) {
  const missing = [];
  if (!trace.scoreAuthority) missing.push("scoreAuthority");
  if (!trace.formula) missing.push("formula");
  if (!Array.isArray(trace.rawEvidence)) missing.push("rawEvidence");
  if (!Array.isArray(trace.normalizedEvidence)) missing.push("normalizedEvidence");
  if (!Array.isArray(trace.weightedContributions)) missing.push("weightedContributions");
  if (!trace.aggregation) missing.push("aggregation");
  if (trace.finalRoundedScore == null) missing.push("finalRoundedScore");
  if (!trace.time) missing.push("time");
  return {
    passed: missing.length === 0,
    missing,
  };
}

function chartContractStatus(overview = {}) {
  const charts = overview?.visualizations?.charts || [];
  const lineCharts = charts.filter((chart) => chart.type === "line");
  const barCharts = charts.filter((chart) => chart.type === "bar");
  return {
    passed: charts.length > 0 && lineCharts.length > 0 && charts.every((chart) =>
      chart.id &&
      chart.key &&
      chart.axis &&
      Array.isArray(chart.series) &&
      Array.isArray(chart.data)
    ),
    chartCount: charts.length,
    lineChartCount: lineCharts.length,
    barChartCount: barCharts.length,
    pointCounts: charts.map((chart) => ({
      key: chart.key,
      type: chart.type,
      points: Array.isArray(chart.data) ? chart.data.length : 0,
    })),
  };
}

function summarySectionStatus(overview = {}) {
  const summary = overview?.executiveSummary || {};
  const sectionKeys = (summary.sections || []).map((section) => section.key);
  const version = summary.persistence?.summaryVersion || summary.quality?.summaryVersion || summary.summaryVersion || null;
  return {
    passed:
      version === PERIOD_EXECUTIVE_SUMMARY_VERSION &&
      Boolean(summary.persistence?.summaryId || summary.summaryId) &&
      sectionKeys.includes("leadershipRecommendations") &&
      sectionKeys.includes("deliveryExecution") &&
      sectionKeys.includes("capacitySustainability") &&
      summary.quality?.passed !== false,
    summary: summarizeExecutiveSummaryPayload(overview),
    recommendationCount: Array.isArray(summary.recommendations)
      ? summary.recommendations.length
      : (summary.sections || []).filter((section) => section.key === "leadershipRecommendations").length,
  };
}

function summarizeExecutiveSummaryPayload(overview) {
  const summary = overview?.executiveSummary || {};
  return {
    summaryId: summary.persistence?.summaryId || summary.summaryId || null,
    reused: Boolean(summary.persistence?.reused),
    version: summary.persistence?.summaryVersion || summary.quality?.summaryVersion || null,
    operationalEvidenceHash: summary.persistence?.operationalEvidenceHash || summary.operationalEvidenceHash || null,
    sectionCount: Array.isArray(summary.sections) ? summary.sections.length : 0,
    sectionKeys: (summary.sections || []).map((section) => section.key),
    qualityPassed: Boolean(summary.quality?.passed),
    qualityChecks: summary.quality?.checks || null,
    qualityWordCount: summary.quality?.wordCount || null,
    qualityUniquenessRatio: summary.quality?.uniquenessRatio || null,
    avoidsScoreCentricLanguage: summary.quality?.checks?.avoidsScoreCentricLanguage ?? null,
    scoreWeightageChangesInvalidateSummary: summary.regenerationPolicy?.scoreWeightageChangesInvalidateSummary ?? null,
    headline: summary.headline || null,
    textLength: String(summary.text || summary.fullSummary || summary.narrative || "").length,
  };
}

async function invalidateExecutiveSummaryEvidenceHash(summaryId) {
  if (!summaryId) return false;
  await pool.query(
    `UPDATE workspace_executive_summaries
     SET source_data = jsonb_set(
       jsonb_set(COALESCE(source_data, '{}'::jsonb), '{operationalEvidenceHash}', '"validation_mismatch"', true),
       '{payload,operationalEvidenceHash}', '"validation_mismatch"',
       true
     )
     WHERE id = $1`,
    [summaryId]
  );
  return true;
}

router.post("/enterprise-intelligence/certify-core", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await certifyEnterpriseIntelligenceCoreWorkspace({
      workspaceId: req.body?.workspaceId,
      executeCutover: req.body?.executeCutover === true,
      updatedBy: req.body?.updatedBy || null,
      ranges: req.body?.ranges,
    });

    return res.status(result.certified ? 200 : 409).json(result);
  } catch (err) {
    const status = err?.code === "CERTIFICATION_WORKSPACE_REQUIRED" ? 400 : 500;
    console.error("[ENTERPRISE_INTELLIGENCE_CERTIFICATION_ERROR]", err);
    return res.status(status).json({
      error: err.message || "Enterprise intelligence certification failed",
      code: err.code || null,
    });
  }
});

router.post("/enterprise-intelligence/user-score-trace", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await traceUserScoreForWorkspace({
      workspaceId: req.body?.workspaceId || null,
      workspaceName: req.body?.workspaceName || "Apyhub",
      userId: req.body?.userId || null,
      userSearch: req.body?.userSearch || "Sukhjinder",
      includeRecomputed: req.body?.includeRecomputed !== false,
    });

    return res.json(result);
  } catch (err) {
    const status = err?.code === "TRACE_WORKSPACE_NOT_FOUND" || err?.code === "TRACE_USER_NOT_FOUND"
      ? 404
      : 500;
    console.error("[ENTERPRISE_INTELLIGENCE_USER_SCORE_TRACE_ERROR]", err);
    return res.status(status).json({
      error: err.message || "Enterprise intelligence user score trace failed",
      code: err.code || null,
    });
  }
});

router.post("/enterprise-intelligence/closure-verify", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const range = req.body?.range || "30d";
    const refreshScoring = req.body?.refreshScoring === true;
    const { rows: adminRows } = await pool.query(
      `SELECT id, username, email, role
       FROM users
       WHERE workspace_id = $1 AND role = 'admin'
       ORDER BY created_at ASC
       LIMIT 1`,
      [workspaceId]
    );
    const admin = adminRows[0];
    if (!admin) {
      return res.status(404).json({ error: "Workspace admin not found" });
    }

    const configBefore = await getWorkspaceScoringConfig({ workspaceId });
    let savedConfig = configBefore;
    let recalculation = null;

    if (refreshScoring) {
      const currentCoreWeight = Number(configBefore?.groups?.userFinalBalance?.weights?.core ?? 0.82);
      savedConfig = await upsertWorkspaceScoringConfig({
        workspaceId,
        updatedBy: admin.id,
        patch: {
          groups: {
            userFinalBalance: {
              changedKey: "core",
              weights: { core: currentCoreWeight },
            },
          },
        },
      });
      const refreshed = await bootstrapWorkspaceIntelligence({
        workspaceId,
        windowDays: 30,
      });
      recalculation = {
        workspaceScore: refreshed.workspace?.score ?? null,
        users: refreshed.users.length,
        projects: refreshed.projects.length,
        teams: refreshed.teams.length,
      };
    }

    const [workspaceHealth, dashboardOverview] = await Promise.all([
      buildWorkspaceHealthResponse({ workspaceId, userId: admin.id, role: "admin" }),
      getDashboardOverviewFromIntelligence({ workspaceId, userId: admin.id, role: "admin", range }),
    ]);
    const pair = savedConfig?.groups?.userFinalBalance?.weights || {};
    const adminSurface = adminScoringConfigSurface(savedConfig);
    const workspaceDomains = workspaceHealth?.scoreExplanation?.domainContributions || [];
    const workspaceCalculation = workspaceHealth?.scoreExplanation?.scoreCalculation || {};

    return res.json({
      source: "enterprise_intelligence_closure_verification",
      generatedAt: new Date().toISOString(),
      workspaceId,
      admin: {
        id: admin.id,
        role: admin.role,
        username: admin.username,
        emailDomain: String(admin.email || "").split("@")[1] || null,
      },
      scoringConfig: {
        persisted: savedConfig.persisted,
        version: savedConfig.version,
        pairWeights: pair,
        pairTotal: Math.round((Number(pair.core || 0) + Number(pair.professionalDiscipline || 0)) * 10000) / 10000,
        adminSurface: {
          source: adminSurface.source,
          editableGroupKeys: adminSurface.editableGroupKeys,
          hiddenGroupKeys: adminSurface.hiddenGroupKeys,
          groupCount: Object.keys(adminSurface.groups || {}).length,
          visibleGroups: Object.keys(adminSurface.groups || {}),
        },
        groups: Object.fromEntries(
          Object.entries(savedConfig.groups || {}).map(([key, group]) => [
            key,
            {
              type: group.type,
              scoreSurface: group.scoreSurface,
              total: group.total,
              slotCount: Object.keys(group.weights || {}).length,
            },
          ])
        ),
        recalculation,
      },
      workspaceHealthExplainability: {
        healthScore: workspaceHealth.healthScore,
        finalScore: workspaceHealth.scoreExplanation?.finalScore ?? null,
        authority: workspaceHealth.scoreExplanation?.scoreAuthority ?? null,
        formula: workspaceHealth.scoreExplanation?.formulaReadable ?? null,
        scoreCalculation: {
          finalScore: workspaceCalculation.finalScore ?? null,
          rawScoreBeforeRounding: workspaceCalculation.rawScoreBeforeRounding ?? null,
          finalRoundedScore: workspaceCalculation.finalRoundedScore ?? null,
          componentCount: Array.isArray(workspaceCalculation.formulaComponents)
            ? workspaceCalculation.formulaComponents.length
            : 0,
          attendanceReadinessContribution: workspaceCalculation.attendanceReadinessContribution || null,
          userScoreBalancePropagation: workspaceCalculation.userScoreBalancePropagation || null,
        },
        domainCount: workspaceDomains.length,
        firstDomains: workspaceDomains.slice(0, 5).map((row) => ({
          key: row.key,
          label: row.label,
          score: row.score,
          weight: row.weight,
          finalScoreImpactVsNeutral: row.finalScoreImpactVsNeutral,
          effect: row.effect?.label || row.effect || null,
        })),
        attendanceEffect: workspaceHealth.scoreExplanation?.attendanceEffect || null,
        upwardPressures: workspaceHealth.scoreExplanation?.upwardPressures || [],
        downwardPressures: workspaceHealth.scoreExplanation?.downwardPressures || [],
      },
      dashboardContract: {
        source: dashboardOverview.source || dashboardOverview.scoreSource || null,
        healthScore: dashboardOverview.healthScore ?? dashboardOverview.scoreCard?.score ?? null,
        chartCount: Array.isArray(dashboardOverview.visualizations?.charts)
          ? dashboardOverview.visualizations.charts.length
          : 0,
        executiveSummarySource: dashboardOverview.executiveSummary?.source || null,
      },
    });
  } catch (err) {
    console.error("[ENTERPRISE_INTELLIGENCE_CLOSURE_VERIFY_ERROR]", err);
    return res.status(500).json({
      error: err.message || "Enterprise intelligence closure verification failed",
      code: err.code || null,
    });
  }
});

router.post("/enterprise-intelligence/executive-summary-v5-verify", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const ranges = Array.isArray(req.body?.ranges) && req.body.ranges.length
      ? req.body.ranges.filter((range) => EXECUTIVE_SUMMARY_VALIDATION_RANGES.includes(range))
      : EXECUTIVE_SUMMARY_VALIDATION_RANGES;
    const executeWeightToggle = req.body?.executeWeightToggle === true;
    const executeEvidenceHashMismatch = req.body?.executeEvidenceHashMismatch === true;

    const admin = await findInternalWorkspaceAdmin(workspaceId);
    if (!admin) {
      return res.status(404).json({ error: "Workspace admin not found" });
    }

    const baselineRecalculation = await bootstrapWorkspaceIntelligence({
      workspaceId,
      windowDays: 30,
    });

    const rangeResults = [];
    for (const range of ranges) {
      const first = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range,
      });
      const second = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range,
      });
      rangeResults.push({
        range,
        first: summarizeExecutiveSummaryPayload(first),
        second: summarizeExecutiveSummaryPayload(second),
      });
    }

    let weightageValidation = null;
    if (executeWeightToggle) {
      const configBefore = await getWorkspaceScoringConfig({ workspaceId });
      const currentCoreWeight = Number(configBefore?.groups?.userFinalBalance?.weights?.core ?? 0.82);
      const targetCoreWeight = currentCoreWeight <= 0.5 ? 0.99 : 0.01;
      const before = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range: "30d",
      });

      await upsertWorkspaceScoringConfig({
        workspaceId,
        updatedBy: admin.id,
        patch: {
          groups: {
            userFinalBalance: {
              changedKey: "core",
              weights: { core: targetCoreWeight },
            },
          },
        },
      });
      const changedRecalc = await bootstrapWorkspaceIntelligence({ workspaceId, windowDays: 30 });
      const afterWeightChange = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range: "30d",
      });

      await upsertWorkspaceScoringConfig({
        workspaceId,
        updatedBy: admin.id,
        patch: {
          groups: {
            userFinalBalance: {
              changedKey: "core",
              weights: { core: currentCoreWeight },
            },
          },
        },
      });
      const restoredRecalc = await bootstrapWorkspaceIntelligence({ workspaceId, windowDays: 30 });
      const restored = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range: "30d",
      });

      const beforeSummary = summarizeExecutiveSummaryPayload(before);
      const changedSummary = summarizeExecutiveSummaryPayload(afterWeightChange);
      const restoredSummary = summarizeExecutiveSummaryPayload(restored);
      weightageValidation = {
        currentCoreWeight,
        targetCoreWeight,
        restoredCoreWeight: currentCoreWeight,
        workspaceScores: {
          before: baselineRecalculation.workspace?.score ?? before.healthScore ?? null,
          afterWeightChange: changedRecalc.workspace?.score ?? afterWeightChange.healthScore ?? null,
          restored: restoredRecalc.workspace?.score ?? restored.healthScore ?? null,
        },
        summaries: {
          before: beforeSummary,
          afterWeightChange: changedSummary,
          restored: restoredSummary,
        },
        summaryRegeneratedByWeightChange: changedSummary.reused === false,
        evidenceHashStableAcrossWeightChange:
          beforeSummary.operationalEvidenceHash === changedSummary.operationalEvidenceHash,
        scoreChangedDuringWeightToggle:
          Number(baselineRecalculation.workspace?.score ?? before.healthScore) !==
          Number(changedRecalc.workspace?.score ?? afterWeightChange.healthScore),
      };
    }

    let operationalEvidenceValidation = null;
    if (executeEvidenceHashMismatch) {
      const before = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range: "30d",
      });
      const beforeSummary = summarizeExecutiveSummaryPayload(before);
      const invalidated = await invalidateExecutiveSummaryEvidenceHash(beforeSummary.summaryId);
      const regenerated = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range: "30d",
      });
      const secondRead = await getDashboardOverviewFromIntelligence({
        workspaceId,
        userId: admin.id,
        role: "admin",
        range: "30d",
      });
      operationalEvidenceValidation = {
        invalidatedStoredEvidenceHash: invalidated,
        before: beforeSummary,
        afterMismatchRead: summarizeExecutiveSummaryPayload(regenerated),
        secondRead: summarizeExecutiveSummaryPayload(secondRead),
      };
    }

    const failures = [];
    for (const result of rangeResults) {
      if (result.second.version !== PERIOD_EXECUTIVE_SUMMARY_VERSION) failures.push(`${result.range} did not return v5`);
      if (result.second.sectionCount < 10) failures.push(`${result.range} missing required sections`);
      if (!result.second.qualityPassed) failures.push(`${result.range} quality check failed`);
      if (!result.second.reused) failures.push(`${result.range} second read did not reuse persisted summary`);
      if (result.second.scoreWeightageChangesInvalidateSummary !== false) failures.push(`${result.range} regeneration policy is not weightage independent`);
    }
    if (weightageValidation && weightageValidation.summaryRegeneratedByWeightChange) {
      failures.push("Score weightage change regenerated the executive summary");
    }
    if (weightageValidation && !weightageValidation.evidenceHashStableAcrossWeightChange) {
      failures.push("Operational evidence hash changed during score weightage toggle");
    }
    if (weightageValidation && !weightageValidation.scoreChangedDuringWeightToggle) {
      failures.push("Score weightage toggle did not change the workspace score");
    }
    if (operationalEvidenceValidation && operationalEvidenceValidation.afterMismatchRead.reused !== false) {
      failures.push("Operational evidence hash mismatch did not force regeneration");
    }
    if (operationalEvidenceValidation && operationalEvidenceValidation.secondRead.reused !== true) {
      failures.push("Regenerated operational summary was not reused on second read");
    }

    return res.status(failures.length ? 409 : 200).json({
      source: "enterprise_executive_summary_v5_verification",
      generatedAt: new Date().toISOString(),
      workspaceId,
      summaryVersion: PERIOD_EXECUTIVE_SUMMARY_VERSION,
      baselineRecalculation: {
        workspaceScore: baselineRecalculation.workspace?.score ?? null,
        users: baselineRecalculation.users?.length ?? 0,
        projects: baselineRecalculation.projects?.length ?? 0,
        teams: baselineRecalculation.teams?.length ?? 0,
      },
      admin: {
        id: admin.id,
        role: admin.role,
        username: admin.username,
        emailDomain: String(admin.email || "").split("@")[1] || null,
      },
      ranges: rangeResults,
      weightageValidation,
      operationalEvidenceValidation,
      failures,
      certified: failures.length === 0,
    });
  } catch (err) {
    console.error("[ENTERPRISE_EXECUTIVE_SUMMARY_V5_VERIFY_ERROR]", err);
    return res.status(500).json({
      error: err.message || "Executive summary v5 verification failed",
      code: err.code || null,
    });
  }
});

/**
 * 🔒 Internal AI reply endpoint
 * Called ONLY by AI service
 */
router.post("/enterprise-intelligence/final-production-certification", async (req, res) => {
  try {
    if (!internalSecretMatches(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workspace = await resolveInternalWorkspace({
      workspaceId: req.body?.workspaceId || null,
      workspaceName: req.body?.workspaceName || "Apyhub",
    });
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const workspaceId = workspace.id;
    const ranges = Array.isArray(req.body?.ranges) && req.body.ranges.length
      ? req.body.ranges.filter((range) => EXECUTIVE_SUMMARY_VALIDATION_RANGES.includes(range))
      : EXECUTIVE_SUMMARY_VALIDATION_RANGES;
    const executeRecalculation = req.body?.executeRecalculation !== false;
    const admin = await findInternalWorkspaceAdmin(workspaceId);
    if (!admin) {
      return res.status(404).json({ error: "Workspace admin not found" });
    }
    const role = admin.role || "admin";

    const recalculation = executeRecalculation
      ? await bootstrapWorkspaceIntelligence({ workspaceId, windowDays: 30 })
      : null;

    const [workspaceHealth, userPerformance, userProjects, projectsHealth, teamComparison] = await Promise.all([
      buildWorkspaceHealthResponse({ workspaceId, userId: admin.id, role }),
      buildUserPerformanceResponse({ workspaceId, userId: admin.id, role }),
      buildUserProjectPerformanceResponse({ workspaceId, userId: admin.id, role }),
      buildProjectsHealthResponse({ workspaceId, userId: admin.id, role }),
      buildTeamComparisonResponse({ workspaceId, userId: admin.id, role }),
    ]);

    const userTrend = {};
    const rangeResults = [];
    for (const range of ranges) {
      const [overview, secondOverview, trend] = await Promise.all([
        getDashboardOverviewFromIntelligence({ workspaceId, userId: admin.id, role, range }),
        getDashboardOverviewFromIntelligence({ workspaceId, userId: admin.id, role, range }),
        buildUserTrendResponse({ workspaceId, userId: admin.id, role, range }),
      ]);
      userTrend[range] = {
        pointCount: Array.isArray(trend.series) ? trend.series.length : 0,
        source: trend.source,
      };
      rangeResults.push({
        range,
        dashboardSource: overview.source || overview.scoreSource || overview.scoreCard?.source || null,
        healthScore: overview.healthScore ?? overview.scoreCard?.score ?? null,
        charts: chartContractStatus(overview),
        executiveSummary: summarySectionStatus(overview),
        persistedSummaryReusedOnSecondRead: Boolean(secondOverview?.executiveSummary?.persistence?.reused),
        time: {
          computedAt: overview.computedAt || overview.time?.computedAt || null,
          coverageStart: overview.coverageStart || overview.time?.coverageStart || null,
          coverageEnd: overview.coverageEnd || overview.time?.coverageEnd || null,
          attendanceClosedThroughDate: overview.attendanceClosedThroughDate || overview.time?.attendanceClosedThroughDate || null,
        },
      });
    }

    const projectTooltipStatuses = (projectsHealth.projects || []).slice(0, 10).map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      tooltip: tooltipContractStatus(project.scoreTooltip),
      trace: traceContractStatus(project.scoreTrace),
    }));
    const teamTooltipStatuses = (teamComparison.canonicalTeams || []).slice(0, 10).map((team) => ({
      teamKey: team.teamKey,
      managerId: team.managerId,
      tooltip: tooltipContractStatus(team.scoreTooltip),
      trace: traceContractStatus(team.scoreTrace),
    }));
    const userDriverTrace = userPerformance?.scoreExplanation?.diagnosticDrivers || [];
    const config = await getWorkspaceScoringConfig({ workspaceId });
    const adminSurface = adminScoringConfigSurface(config);

    const checks = {
      workspaceTooltip: tooltipContractStatus(workspaceHealth.scoreTooltip),
      workspaceTrace: traceContractStatus(workspaceHealth.scoreTrace),
      userTooltip: tooltipContractStatus(userPerformance?.scoreTooltip),
      userTrace: traceContractStatus(userPerformance?.scoreTrace),
      userDiagnosticDriverTrace: {
        passed: userDriverTrace.length > 0 && userDriverTrace.every((driver) =>
          driver.trace &&
          driver.feeds &&
          driver.domain &&
          Object.prototype.hasOwnProperty.call(driver, "finalContribution")
        ),
        driverCount: userDriverTrace.length,
      },
      attendanceContribution: {
        passed: Boolean(
          userPerformance?.scoreExplanation?.attendanceContribution &&
          workspaceHealth?.scoreExplanation?.attendanceEffect
        ),
        userAttendanceScore: userPerformance?.breakdown?.attendanceScore ?? null,
        workspaceAttendanceReadiness: workspaceHealth?.indexes?.attendanceReadinessIndex ?? null,
      },
      projectsTooltip: {
        passed: projectTooltipStatuses.every((row) => row.tooltip.passed && row.trace.passed),
        checked: projectTooltipStatuses.length,
        rows: projectTooltipStatuses,
      },
      teamsTooltip: {
        passed: teamTooltipStatuses.every((row) => row.tooltip.passed && row.trace.passed),
        checked: teamTooltipStatuses.length,
        rows: teamTooltipStatuses,
      },
      dashboardRanges: {
        passed: rangeResults.every((row) =>
          row.charts.passed &&
          row.executiveSummary.passed &&
          row.dashboardSource === "enterprise_intelligence"
        ),
        ranges: rangeResults,
      },
      userTrend,
      scoringConfig: {
        passed: adminSurface.source === "enterprise_intelligence_scoring_config_admin_surface",
        persisted: config.persisted,
        version: config.version,
        visibleGroups: Object.keys(adminSurface.groups || {}),
      },
      userProjectRows: {
        passed: Array.isArray(userProjects.rows || userProjects.projects),
        count: (userProjects.rows || userProjects.projects || []).length,
      },
      recalculation: {
        executed: executeRecalculation,
        workspaceScore: recalculation?.workspace?.score ?? null,
        users: recalculation?.users?.length ?? null,
        projects: recalculation?.projects?.length ?? null,
        teams: recalculation?.teams?.length ?? null,
      },
    };

    const failures = [];
    for (const [key, value] of Object.entries(checks)) {
      if (value && Object.prototype.hasOwnProperty.call(value, "passed") && !value.passed) {
        failures.push(key);
      }
    }
    for (const result of rangeResults) {
      if (!result.charts.passed) failures.push(`${result.range}:dashboard_charts`);
      if (!result.executiveSummary.passed) failures.push(`${result.range}:executive_summary`);
      if (!result.persistedSummaryReusedOnSecondRead) failures.push(`${result.range}:summary_reuse`);
    }

    return res.status(failures.length ? 409 : 200).json({
      source: "enterprise_intelligence_final_production_certification",
      generatedAt: new Date().toISOString(),
      workspace: {
        id: workspaceId,
        name: workspace.name,
      },
      admin: {
        id: admin.id,
        role: admin.role,
        username: admin.username,
        emailDomain: String(admin.email || "").split("@")[1] || null,
      },
      ranges,
      checks,
      failures,
      certified: failures.length === 0,
    });
  } catch (err) {
    console.error("[ENTERPRISE_INTELLIGENCE_FINAL_PRODUCTION_CERTIFICATION_ERROR]", err);
    return res.status(500).json({
      error: err.message || "Final production certification failed",
      code: err.code || null,
    });
  }
});

router.post("/ai/reply", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      channelKey,
      workspaceId,
      textHtml,
      parentId = null,
    } = req.body || {};

    if (!channelKey || !workspaceId || !textHtml) {
      return res.status(400).json({
        error: "channelKey, workspaceId, textHtml are required",
      });
    }

    const msg = await createAIChatMessage({
      channelKey,
      workspaceId,
      textHtml,
      parentId,
    });

    return res.json({
      success: true,
      messageId: msg.id,
    });
  } catch (err) {
    console.error("[INTERNAL_AI_REPLY_ERROR]", err);
    return res.status(500).json({ error: "AI reply failed" });
  }
});

/**
 * 🔒 Internal AI → Read workspace AI settings
 * Used ONLY by AI service (no JWT, no user auth)
 */
/**
 * 🔐 Internal: Read workspace AI settings
 * Used ONLY by AI service (no JWT)
 */
router.get("/workspace-ai-settings/:workspaceId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId } = req.params;

    const { rows } = await pool.query(
      `
      SELECT ai_enabled, ai_auto_reply
      FROM workspace_ai_settings
      WHERE workspace_id = $1
      `,
      [workspaceId]
    );

    // Default = enabled
    res.json(
      rows[0] || {
        ai_enabled: true,
        ai_auto_reply: true,
      }
    );
  } catch (err) {
    console.error("[INTERNAL_AI_SETTINGS_ERROR]", err);
    res.status(500).json({ error: "Failed to fetch AI settings" });
  }
});

/**
 * 🔒 Internal: Ensure a user's private AI notification channel exists.
 * Creates it if missing. Returns the stable channel key.
 * Channel name = the AI name set in workspace settings.
 */
router.post("/ai/ensure-notify-channel", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId, workspaceId } = req.body || {};
    if (!userId || !workspaceId) {
      return res.status(400).json({ error: "userId and workspaceId required" });
    }

    // Stable, predictable key — one per user
    const channelKey = `ai-notify:${userId}`;

    // Return existing channel if already created
    const existing = await pool.query(
      `SELECT key FROM chat_channels WHERE key = $1 AND workspace_id = $2`,
      [channelKey, workspaceId]
    );
    if (existing.rows.length) {
      return res.json({ channelKey });
    }

    // Look up the AI name for this workspace
    const aiNameRes = await pool.query(
      `SELECT COALESCE(ai_name, 'AI Assistant') AS ai_name
       FROM workspace_ai_settings
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    const aiName = aiNameRes.rows[0]?.ai_name || "AI Assistant";

    // Look up the AI system user for this workspace
    const aiUserRes = await pool.query(
      `SELECT user_id FROM system_users WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    );
    const aiUserId = aiUserRes.rows[0]?.user_id;
    if (!aiUserId) {
      return res.status(500).json({ error: "AI system user not found for workspace" });
    }

    // Create the channel (AI user is creator, user is member, read-only via type)
    await pool.query(
      `INSERT INTO chat_channels (id, key, name, type, created_by, is_private, workspace_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'ai-notify', $3, true, $4, now())`,
      [channelKey, aiName, aiUserId, workspaceId]
    );

    // Add the user as a member (read-only — they can see but not post)
    const channelRes = await pool.query(
      `SELECT id FROM chat_channels WHERE key = $1`,
      [channelKey]
    );
    const channelId = channelRes.rows[0].id;

    await pool.query(
      `INSERT INTO chat_channel_members (id, channel_id, user_id)
       VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`,
      [channelId, userId]
    );

    return res.json({ channelKey });
  } catch (err) {
    console.error("[INTERNAL_ENSURE_NOTIFY_CHANNEL_ERROR]", err);
    return res.status(500).json({ error: "Failed to ensure notify channel" });
  }
});

/**
 * 🔒 Internal AI Memory Storage (WMDPE)
 * Stores opaque AI memory as JSON per workspace
 * Used ONLY by AI service
 */

// Save / update AI memory
router.post("/ai/memory", async (req, res) => {
  try {
    // 🔐 Shared-secret auth (same as other internal AI routes)
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId, type, payload } = req.body || {};

    if (!workspaceId || !type || payload === undefined) {
      return res.status(400).json({
        error: "workspaceId, type, payload are required",
      });
    }

    await pool.query(
      `
      INSERT INTO ai_memory (workspace_id, type, payload, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (workspace_id, type)
      DO UPDATE SET payload = $3, updated_at = NOW()
      `,
      [workspaceId, type, payload]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[INTERNAL_AI_MEMORY_SAVE_ERROR]", err);
    return res.status(500).json({ error: "Failed to save AI memory" });
  }
});

// Fetch all DM conversations for a specific user (used for away summary on disable)
router.get("/ai/conversations/:userId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;
    const { workspaceId } = req.query;

    if (!userId || !workspaceId) {
      return res.status(400).json({ error: "userId and workspaceId required" });
    }

    const { rows } = await pool.query(
      `SELECT type, payload
       FROM ai_memory
       WHERE workspace_id = $1
         AND type LIKE 'dm_conv:%'
         AND payload->>'recipientId' = $2
         AND (payload->>'cleared' IS NULL OR payload->>'cleared' = 'false')`,
      [workspaceId, userId]
    );

    // Extract channelKey from type ("dm_conv:channelKey") and return
    const conversations = rows.map((r) => ({
      channelKey: r.type.replace("dm_conv:", ""),
      messages: r.payload?.messages || [],
      hasGreeted: r.payload?.hasGreeted || false,
    }));

    return res.json({ conversations });
  } catch (err) {
    console.error("[INTERNAL_AI_CONVERSATIONS_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// Read AI memory
router.get("/ai/memory", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId, type } = req.query;

    if (!workspaceId || !type) {
      return res.status(400).json({
        error: "workspaceId and type are required",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT payload
      FROM ai_memory
      WHERE workspace_id = $1 AND type = $2
      `,
      [workspaceId, type]
    );

    return res.json({
      payload: rows[0]?.payload || null,
    });
  } catch (err) {
    console.error("[INTERNAL_AI_MEMORY_READ_ERROR]", err);
    return res.status(500).json({ error: "Failed to read AI memory" });
  }
});

/**
 * 🔒 Internal: Read workspace chat history for AI (WMDPE)
 * Read-only, used ONLY by AI service
 */
router.get("/workspace-history/:workspaceId", async (req, res) => {
  try {
    // 🔐 Shared-secret auth
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { workspaceId } = req.params;

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId required" });
    }

    // 🔍 Read recent messages (limit for safety)
    const { rows } = await pool.query(
  `
  SELECT
  id,
  user_id,
  workspace_id,
  channel_key,
  created_at
FROM chat_messages
WHERE workspace_id = $1
ORDER BY created_at DESC
LIMIT 200
  `,
  [workspaceId]
);

    return res.json({
      messages: rows,
    });
  } catch (err) {
    console.error("[INTERNAL_WORKSPACE_HISTORY_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch workspace history" });
  }
});

/**
 * 🧠 Explain why AI replied to a message
 * Used by frontend (authenticated users)
 */
router.get("/ai/explain/:messageId", async (req, res) => {
  try {
    const { messageId } = req.params;
    const workspaceId = req.workspaceId || req.headers["x-workspace-id"];

    const { rows } = await pool.query(
      `
      SELECT explanation, confidence, model, context, created_at
      FROM ai_decision_provenance
      WHERE message_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [messageId, workspaceId]
    );

    if (!rows.length) {
  return res.json({
    available: false,
    pending: true, // 🔥 KEY FIX
  });
}

let parsed = null;
try {
  parsed =
    typeof rows[0].explanation === "string"
      ? JSON.parse(rows[0].explanation)
      : rows[0].explanation;
} catch {
  parsed = null;
}

if (!parsed) {
  return res.json({
    available: false,
    pending: false,
    error: "Explanation could not be parsed",
  });
}

return res.json({
  available: true,
  explanation: {
    summary: parsed.summary || "AI responded based on the user's message.",
    reasoning: parsed.reasoning || [],
    triggerMessage: parsed.triggerMessage || null,
    detectedIntent: parsed.detectedIntent || null,
  },
  confidence: rows[0].confidence,
  model: rows[0].model,
  context: rows[0].context,
  createdAt: rows[0].created_at,
});
  } catch (err) {
    return res.status(500).json({ available: false });
  }
});

router.post("/ai/provenance", async (req, res) => {
  try {
    const {
      workspaceId,
      messageId,
      channelKey,
      triggerMessageId,
      explanation,
      confidence,
      model,
      context,
    } = req.body;

    // 🔐 CRITICAL SAFETY FIX
    // If messageId is missing, skip provenance write
    if (!messageId) {
      console.warn(
        "[AI_PROVENANCE_SKIPPED] messageId missing, provenance not written"
      );
      return res.json({ ok: true, skipped: true });
    }

    await pool.query(
      `
      INSERT INTO ai_decision_provenance (
        workspace_id,
        message_id,
        channel_key,
        trigger_message_id,
        explanation,
        confidence,
        model,
        context
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        workspaceId,
        messageId,
        channelKey,
        triggerMessageId,
        explanation,
        confidence,
        model,
        context || {},
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[AI_PROVENANCE_WRITE_ERROR]", err);
    res.status(500).json({ error: "failed_to_record_ai_provenance" });
  }
});

/**
 * 🔒 Internal: Get a user's AI auto-reply preference
 * Called by AI service to check if recipient has opted in before replying
 */
router.get("/user-ai-preference/:userId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.params;

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.workspace_id, up.ai_reply_enabled
       FROM users u
       LEFT JOIN user_preferences up ON up.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      userId: rows[0].id,
      username: rows[0].username,
      workspaceId: rows[0].workspace_id,
      ai_reply_enabled: rows[0].ai_reply_enabled ?? false, // default OFF
    });
  } catch (err) {
    console.error("[INTERNAL_USER_AI_PREF_ERROR]", err);
    res.status(500).json({ error: "Failed to fetch user AI preference" });
  }
});

/**
 * 🔒 Internal: Get away user's context for AI auto-reply
 * Returns projects, active tasks, overdue tasks so the AI can give informed answers
 * Called ONLY by AI service
 */
router.get("/user-context/:awayUserId", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { awayUserId } = req.params;
    const { workspaceId, projectIds } = req.query;

    if (!awayUserId || !workspaceId) {
      return res.status(400).json({ error: "awayUserId and workspaceId required" });
    }

    // Optional project filter — if provided, only return data from those projects
    // projectIds is a comma-separated list of UUIDs sent by the AI service
    const projectIdList = projectIds
      ? projectIds.split(",").map((id) => id.trim()).filter(Boolean)
      : null;

    // Build project filter clause (applies to all task queries when filter is set)
    const projectFilter = projectIdList?.length
      ? `AND t.project_id = ANY($3::uuid[])`
      : "";
    const taskParams = (base) =>
      projectIdList?.length ? [...base, projectIdList] : base;

    const [
      { rows: projects },
      { rows: activeTasks },
      { rows: overdueTasks },
      { rows: recentlyCompleted },
      { rows: createdTasks },
      { rows: taskActivity },
      { rows: attendanceRecent },
      { rows: attendanceEvents },
    ] = await Promise.all([
      // Projects (scoped to filter if provided, else all user's assigned projects)
      projectIdList?.length
        ? pool.query(
            `SELECT id, name FROM projects
             WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
            [workspaceId, projectIdList]
          )
        : pool.query(
            `SELECT DISTINCT p.id, p.name
             FROM projects p
             JOIN tasks t ON t.project_id = p.id
             WHERE p.workspace_id = $2 AND t.assigned_to = $1
             LIMIT 15`,
            [awayUserId, workspaceId]
          ),
      // Active assigned tasks (not overdue)
      pool.query(
        `SELECT t.id, t.task AS title, t.status, t.due_date, t.updated_at, p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assigned_to = $1 AND t.workspace_id = $2
           AND t.status NOT IN ('completed', 'cancelled')
           AND (t.due_date IS NULL OR t.due_date >= CURRENT_DATE)
           ${projectFilter}
         ORDER BY t.due_date ASC NULLS LAST
         LIMIT 10`,
        taskParams([awayUserId, workspaceId])
      ),
      // Overdue assigned tasks
      pool.query(
        `SELECT t.id, t.task AS title, t.status, t.due_date, t.updated_at, p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assigned_to = $1 AND t.workspace_id = $2
           AND t.status NOT IN ('completed', 'cancelled')
           AND t.due_date < CURRENT_DATE
           ${projectFilter}
         ORDER BY t.due_date ASC
         LIMIT 5`,
        taskParams([awayUserId, workspaceId])
      ),
      // Recently completed tasks (last 14 days)
      pool.query(
        `SELECT t.id, t.task AS title, t.status, t.due_date, t.updated_at, p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assigned_to = $1 AND t.workspace_id = $2
           AND t.status = 'completed'
           AND t.updated_at >= NOW() - INTERVAL '14 days'
           ${projectFilter}
         ORDER BY t.updated_at DESC
         LIMIT 5`,
        taskParams([awayUserId, workspaceId])
      ),
      // Placeholder — createdTasks requires added_by column; returns empty for safety
      Promise.resolve({ rows: [] }),
      // Task activity logs — recent changes on this user's tasks (last 14 days)
      pool.query(
        `SELECT tal.action_type, tal.old_value, tal.new_value, tal.created_at,
                t.task AS task_title, u.username AS actor_name
         FROM task_activity_logs tal
         JOIN tasks t ON t.id = tal.task_id
         LEFT JOIN users u ON u.id = tal.actor_id
         WHERE t.assigned_to = $1 AND tal.workspace_id = $2
           AND tal.created_at >= NOW() - INTERVAL '14 days'
         ORDER BY tal.created_at DESC
         LIMIT 20`,
        [awayUserId, workspaceId]
      ),
      // Attendance: last 30 days from daily aggregates
      pool.query(
        `SELECT date, signed_in_minutes, available_minutes, aws_minutes, lunch_minutes
         FROM attendance_daily
         WHERE user_id = $1 AND workspace_id = $2
           AND date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY date DESC
         LIMIT 14`,
        [awayUserId, workspaceId]
      ),
      // Attendance events: last sign-in per day (fallback if daily table is empty)
      pool.query(
        `SELECT date(started_at) AS date, max(started_at) AS last_event
         FROM attendance_events
         WHERE user_id = $1 AND workspace_id = $2
           AND event_type = 'SIGN_IN'
           AND started_at >= NOW() - INTERVAL '30 days'
         GROUP BY date(started_at)
         ORDER BY date DESC
         LIMIT 14`,
        [awayUserId, workspaceId]
      ),
    ]);

    return res.json({ projects, activeTasks, overdueTasks, recentlyCompleted, createdTasks, attendanceRecent, attendanceEvents, taskActivity });
  } catch (err) {
    console.error("[INTERNAL_USER_CONTEXT_ERROR]", err.message, err.stack?.split("\n")[1]);
    return res.status(500).json({ error: "Failed to fetch user context", detail: err.message });
  }
});

/**
 * 🔒 Internal: Check if two users are associated (share a project or task)
 * Used by AI auto-reply to decide whether data sharing is permitted
 * Called ONLY by AI service
 */
router.get("/association", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");
    if (token !== process.env.AI_SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { awayUserId, askingUserId, workspaceId } = req.query;

    if (!awayUserId || !askingUserId || !workspaceId) {
      return res.status(400).json({ error: "awayUserId, askingUserId, workspaceId required" });
    }

    // Find projects where BOTH users have assigned tasks
    const { rows } = await pool.query(
      `SELECT p.id, p.name
       FROM projects p
       WHERE p.workspace_id = $3
         AND EXISTS (
           SELECT 1 FROM tasks
           WHERE assigned_to = $1 AND project_id = p.id
         )
         AND EXISTS (
           SELECT 1 FROM tasks
           WHERE assigned_to = $2 AND project_id = p.id
         )`,
      [awayUserId, askingUserId, workspaceId]
    );

    const associated = rows.length > 0;
    return res.json({
      associated,
      sharedProjects: rows,
      reason: associated ? "shared_project" : "none",
    });
  } catch (err) {
    console.error("[INTERNAL_ASSOCIATION_CHECK_ERROR]", err);
    return res.status(500).json({ error: "Association check failed" });
  }
});

/**
 * 🔒 Internal: Fetch project reports (used by frontend)
 */
router.get("/reports/project", async (req, res) => {
  try {
    const { workspaceId, projectName, fromDate, toDate } = req.query;

    if (!workspaceId || !projectName || !fromDate || !toDate) {
      return res.status(400).json({
        error: "workspaceId, projectName, fromDate, toDate are required",
      });
    }

    const from = new Date(fromDate);
const to = new Date(toDate);

if (isNaN(from.getTime()) || isNaN(to.getTime())) {
  return res.status(400).json({
    error: "invalid_dates",
    message: "Invalid date format",
  });
}

if (from > to) {
  return res.status(400).json({
    error: "invalid_date_range",
    message: "From date cannot be after To date",
  });
}

    const report = await getProjectReport({
      workspaceId,
      projectName,
      fromDate,
      toDate,
    });

    return res.json(report);
  } catch (err) {
    console.error("[REPORT_FETCH_ERROR]", err);
    return res.status(500).json({ error: "Failed to fetch report" });
  }
});

export default router;
