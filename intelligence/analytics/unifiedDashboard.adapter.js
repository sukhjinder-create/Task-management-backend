import pool from "../../db.js";
import { getUnifiedIntelligenceSnapshot } from "../engine/unifiedIntelligence.engine.js";
import {
  buildDashboardVisualizations,
  dashboardRangeMeta,
} from "./dashboardChartContract.service.js";
import { buildTrendAnalytics, getHistoricalSeries } from "./historicalAnalytics.service.js";
import { advancedForecast } from "../forecast/forecast.engine.js";
import { ensureDashboardHistoryMaterialized } from "../snapshots/historicalBackfill.service.js";
import { getOrCreateWorkspacePeriodExecutiveSummary } from "./periodExecutiveSummary.service.js";

function normalizeTrend(direction) {
  if (direction === "up") return "improving";
  if (direction === "down") return "declining";
  return "stable";
}

async function resolveScope({ workspaceId, userId, role }) {
  if (role === "admin") {
    const { rows } = await pool.query(
      `SELECT id, name FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return {
      type: "workspace",
      label: "Workspace",
      projectIds: rows.map((row) => row.id),
    };
  }

  if (role === "manager") {
    const { rows } = await pool.query(
      `SELECT p.id, p.name
       FROM projects p
       JOIN users u ON u.id = $2
       WHERE p.workspace_id = $1
         AND p.id = ANY(u.projects)
       ORDER BY p.created_at DESC`,
      [workspaceId, userId]
    );
    return {
      type: "managed_projects",
      label: "Managed Projects",
      projectIds: rows.map((row) => row.id),
    };
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.workspace_id = $1
       AND t.assigned_to = $2
     ORDER BY p.name ASC`,
    [workspaceId, userId]
  );
  return {
    type: "self",
    label: "My Work",
    projectIds: rows.map((row) => row.id),
  };
}

async function taskCounts({ workspaceId, userId, role, projectIds }) {
  if (projectIds.length === 0) {
    return {
      counts: { totalProjects: 0, totalTasks: 0, pendingTasks: 0, inProgressTasks: 0, completedTasks: 0, overdueTasks: 0 },
      myTasks: { total: 0, overdue: 0, completed: 0 },
      topOverdue: [],
    };
  }

  const scopeParams = [workspaceId, projectIds];
  let scopeUserClause = "";
  if (role === "user") {
    scopeUserClause = "AND t.assigned_to = $3";
    scopeParams.push(userId);
  }

  const [summary, mine, overdue] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_tasks,
         COUNT(*) FILTER (WHERE t.status = 'pending')::int AS pending_tasks,
         COUNT(*) FILTER (WHERE t.status IN ('in-progress','in_progress'))::int AS in_progress_tasks,
         COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
         COUNT(*) FILTER (
           WHERE t.due_date IS NOT NULL
             AND t.status NOT IN ('completed','done','closed','cancelled')
             AND t.due_date < NOW()::date
         )::int AS overdue_tasks
       FROM tasks t
       WHERE t.workspace_id = $1
         AND t.project_id = ANY($2::uuid[])
         ${scopeUserClause}`,
      scopeParams
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE t.due_date IS NOT NULL
             AND t.status NOT IN ('completed','done','closed','cancelled')
             AND t.due_date < NOW()::date
         )::int AS overdue,
         COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed
       FROM tasks t
       WHERE t.workspace_id = $1
         AND t.project_id = ANY($2::uuid[])
         AND t.assigned_to = $3`,
      [workspaceId, projectIds, userId]
    ),
    pool.query(
      `SELECT
         t.id,
         t.project_id,
         p.name AS project_name,
         t.task,
         t.status,
         t.priority,
         t.due_date,
         GREATEST(1, (NOW()::date - t.due_date::date))::int AS overdue_days
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.workspace_id = $1
         AND t.project_id = ANY($2::uuid[])
         AND t.status NOT IN ('completed','done','closed','cancelled')
         AND t.due_date IS NOT NULL
         AND t.due_date < NOW()::date
         ${role === "user" ? "AND t.assigned_to = $3" : ""}
       ORDER BY overdue_days DESC, t.due_date ASC
       LIMIT 8`,
      role === "user" ? [workspaceId, projectIds, userId] : [workspaceId, projectIds]
    ),
  ]);

  const row = summary.rows[0] || {};
  return {
    counts: {
      totalProjects: projectIds.length,
      totalTasks: Number(row.total_tasks) || 0,
      pendingTasks: Number(row.pending_tasks) || 0,
      inProgressTasks: Number(row.in_progress_tasks) || 0,
      completedTasks: Number(row.completed_tasks) || 0,
      overdueTasks: Number(row.overdue_tasks) || 0,
    },
    myTasks: {
      total: Number(mine.rows[0]?.total) || 0,
      overdue: Number(mine.rows[0]?.overdue) || 0,
      completed: Number(mine.rows[0]?.completed) || 0,
    },
    topOverdue: overdue.rows,
  };
}

function projectHealthFromIntelligence(projects = [], projectIds = []) {
  const allowed = new Set(projectIds.map(String));
  return projects
    .filter((project) => allowed.has(String(project.projectId)))
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      totalTasks: project.analytics?.totalTasks || 0,
      completedTasks: project.analytics?.completedTasks || 0,
      overdueTasks: project.analytics?.overdueTasks || 0,
      completionRate: project.analytics?.completionRate || 0,
      score: project.score,
      band: project.band,
      risk: project.risk,
      completionConfidence: project.indexes?.completionConfidence ?? project.analytics?.completionConfidence ?? project.score,
      velocityHealth: project.indexes?.velocityHealth ?? null,
    }))
    .slice(0, 10);
}

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 100) / 100;
}

function rangeLabel(rangeMeta) {
  if (rangeMeta?.value === "all") return "full available history";
  return rangeMeta?.label || "30D";
}

function directionLabel(direction) {
  if (direction === "up") return "improving";
  if (direction === "down") return "declining";
  return "stable";
}

function latestSeriesScore(series = [], fallback = null) {
  const scores = series.map((point) => Number(point.score)).filter(Number.isFinite);
  if (scores.length) return scores[scores.length - 1];
  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
}

function chartAverage(visualizations, key) {
  const chart = (visualizations?.charts || []).find((item) => item.key === key);
  const values = (chart?.data || []).map((point) => Number(point.value)).filter(Number.isFinite);
  return avg(values);
}

function buildDashboardForecast({ trendSeries, subject, counts, rangeMeta }) {
  const scores = (trendSeries || []).map((point) => Number(point.score)).filter(Number.isFinite);
  const trend = buildTrendAnalytics(trendSeries);
  const currentScore = latestSeriesScore(trendSeries, subject?.score);
  const completionRate = Number(subject?.indexes?.deliveryConfidenceIndex ?? 0) / 100;

  if (scores.length >= 3) {
    const forecast = advancedForecast(scores, { completionRate });
    return {
      ...forecast,
      direction: trend.direction,
      delta: trend.delta,
      currentScore,
      confidenceScore: subject?.confidence ?? null,
      range: rangeMeta,
      source: "enterprise_intelligence_snapshots",
      reasoning:
        forecast.reasoning ||
        `Outlook is based on ${scores.length} enterprise intelligence snapshot(s) in the selected ${rangeLabel(rangeMeta)} period.`,
    };
  }

  const riskLevel = String(subject?.risk?.level || "unknown").toLowerCase();
  const riskProjection = riskLevel === "high" ? "high" : riskLevel === "low" ? "low" : riskLevel === "medium" ? "moderate" : "unknown";
  return {
    predictedAverage: currentScore,
    trend: directionLabel(trend.direction),
    direction: trend.direction,
    delta: trend.delta,
    riskProjection,
    confidence: "low",
    momentum: 0,
    currentScore,
    confidenceScore: subject?.confidence ?? null,
    range: rangeMeta,
    source: "enterprise_intelligence_current_snapshot",
    reasoning:
      `Only ${scores.length} historical intelligence snapshot(s) are available for the selected ${rangeLabel(rangeMeta)} period. ` +
      `The outlook therefore uses the current authoritative intelligence posture (${currentScore ?? "unavailable"}/100), ` +
      `${counts?.overdueTasks || 0} overdue scoped task(s), and current risk level ${subject?.risk?.level || "unknown"} until more snapshot history is available.`,
  };
}

function buildExecutiveSummary({ role, scopeLabel, intelligence, counts, topOverdue, trendSeries, rangeMeta, visualizations, forecast }) {
  const subject = intelligence || {};
  const topRiskTask = topOverdue?.[0];
  const trendAnalytics = buildTrendAnalytics(trendSeries);
  const score = latestSeriesScore(trendSeries, subject.score) ?? 0;
  const band = subject.band || "Unavailable";
  const strengths = subject.strengths || [];
  const concerns = subject.concerns || [];
  const period = rangeLabel(rangeMeta);
  const delta = Number(trendAnalytics.delta) || 0;
  const direction = directionLabel(trendAnalytics.direction);
  const healthAverage = chartAverage(visualizations, "workspace_health_trends");
  const productivityAverage = chartAverage(visualizations, "productivity_trends");
  const riskAverage = chartAverage(visualizations, "risk_trends");
  const dataQualifier = trendSeries.length > 1
    ? `${trendSeries.length} historical intelligence snapshot(s)`
    : "the current authoritative intelligence snapshot";
  const priorities = [
    ...(concerns.slice(0, 3)),
    "Keep intelligence snapshots current through event-driven recalculation.",
  ].slice(0, 4);

  if (role === "user") {
    return {
      headline: `${scopeLabel}: ${period} ${direction} personal intelligence (${score}/100)`,
      narrative:
        `For ${period}, personal intelligence is ${band} at ${score}/100 and ${direction} by ${Math.abs(delta)} point(s). ` +
        `This view is grounded in ${dataQualifier}, ${counts.overdueTasks || 0} overdue task(s), and current delivery/workload evidence. ` +
        `${concerns[0] || strengths[0] || "Keep delivery, collaboration, and sustainability signals balanced."}`,
      outlook: forecast?.reasoning || null,
      strengths,
      risks: concerns,
      priorities,
      drivers: subject.drivers || [],
      period: rangeMeta,
      metrics: { score, delta, direction, snapshotCount: trendSeries.length },
    };
  }

  return {
    headline: `${scopeLabel}: ${period} ${direction} intelligence posture (${score}/100)`,
    narrative:
      `Across ${period}, the intelligence posture is ${band} at ${score}/100 and ${direction} by ${Math.abs(delta)} point(s). ` +
      `The summary is backed by ${dataQualifier}, confidence ${subject.confidence || 0}/100, ` +
      `${counts.totalTasks || 0} scoped task(s), ${counts.overdueTasks || 0} overdue item(s), ` +
      `average health ${healthAverage ?? "n/a"}, productivity ${productivityAverage ?? "n/a"}, and risk ${riskAverage ?? "n/a"}. ` +
      `${topRiskTask ? `Highest urgency: "${topRiskTask.task}" (${topRiskTask.overdue_days} day(s) overdue).` : concerns[0] || strengths[0] || "No concentrated risk is currently visible."}`,
    outlook: forecast?.reasoning || null,
    strengths,
    risks: concerns,
    priorities,
    drivers: subject.drivers || [],
    period: rangeMeta,
    metrics: {
      score,
      delta,
      direction,
      snapshotCount: trendSeries.length,
      healthAverage,
      productivityAverage,
      riskAverage,
      scopedTasks: counts.totalTasks || 0,
      overdueTasks: counts.overdueTasks || 0,
    },
  };
}

async function getManagerTeamSubject({ workspaceId, userId, teams }) {
  const direct = teams.find((team) => team.teamKey === `manager:${userId}`);
  if (direct) return direct;
  return teams.find((team) => team.managerId === userId) || null;
}

export async function getDashboardOverviewFromIntelligence({ workspaceId, userId, role, range = "30d" }) {
  const rangeMeta = dashboardRangeMeta(range);
  const [scope, snapshot] = await Promise.all([
    resolveScope({ workspaceId, userId, role }),
    getUnifiedIntelligenceSnapshot({ workspaceId, userId, role }),
  ]);

  const scopedProjects = projectHealthFromIntelligence(snapshot.projects, scope.projectIds);
  const scoped = await taskCounts({ workspaceId, userId, role, projectIds: scope.projectIds });

  const subject = role === "admin"
    ? snapshot.workspace
    : role === "manager"
      ? await getManagerTeamSubject({ workspaceId, userId, teams: snapshot.teams }) || snapshot.workspace
      : snapshot.currentUser;

  const scoreCard = {
    unifiedScore: subject?.score || 0,
    productivityScore:
      subject?.indexes?.productivityIndex
      ?? subject?.indexes?.teamPerformanceIndex
      ?? subject?.dimensions?.deliveryEffectiveness?.score
      ?? subject?.score
      ?? 0,
    attendanceScore:
      subject?.attendance?.score
      ?? subject?.dimensions?.professionalDiscipline?.metrics?.attendanceScore
      ?? null,
    band: subject?.band || null,
    confidence: subject?.confidence || 0,
    source: "enterprise_intelligence",
  };

  const historyScope = {
    scopeType: role === "user" ? "user" : role === "manager" ? "team" : "workspace",
    subjectKey: role === "user" ? String(userId) : role === "manager" ? `manager:${userId}` : String(workspaceId),
  };
  let trendSeries = await getHistoricalSeries({
    workspaceId,
    scopeType: historyScope.scopeType,
    subjectKey: historyScope.subjectKey,
    range: rangeMeta.value,
  });
  let historyMaterialization = {
    materialized: false,
    reason: trendSeries.length >= 2 ? "sufficient_selected_range_history" : "not_attempted",
    pointCount: trendSeries.length,
  };

  if (trendSeries.length < 2) {
    try {
      historyMaterialization = await ensureDashboardHistoryMaterialized({
        workspaceId,
        scopeType: historyScope.scopeType,
        subjectKey: historyScope.subjectKey,
        range: rangeMeta.value,
      });
      trendSeries = await getHistoricalSeries({
        workspaceId,
        scopeType: historyScope.scopeType,
        subjectKey: historyScope.subjectKey,
        range: rangeMeta.value,
      });
      historyMaterialization.selectedRangePointCount = trendSeries.length;
    } catch (err) {
      historyMaterialization = {
        materialized: false,
        failed: true,
        reason: "selected_range_materialization_failed",
        pointCount: trendSeries.length,
        error: err?.message || "Dashboard history materialization failed",
      };
    }
  }
  const trendAnalytics = buildTrendAnalytics(trendSeries);

  const visualizations = buildDashboardVisualizations({
    role,
    trendSeries,
    snapshot,
    scopedProjects,
    rangeMeta,
  });
  const forecast = buildDashboardForecast({
    trendSeries,
    subject,
    counts: scoped.counts,
    rangeMeta,
  });
  const executiveSummary = role === "admin"
    ? await getOrCreateWorkspacePeriodExecutiveSummary({
      workspaceId,
      scopeLabel: scope.label,
      intelligence: subject,
      counts: scoped.counts,
      topOverdue: scoped.topOverdue,
      trendSeries,
      rangeMeta,
      visualizations,
      forecast,
      materialization: historyMaterialization,
    })
    : buildExecutiveSummary({
      role,
      scopeLabel: scope.label,
      intelligence: subject,
      counts: scoped.counts,
      topOverdue: scoped.topOverdue,
      trendSeries,
      rangeMeta,
      visualizations,
      forecast,
    });

  return {
    role,
    month: new Date().toISOString().slice(0, 7),
    dashboardRange: rangeMeta,
    scope: {
      type: scope.type,
      label: scope.label,
      projectCount: scope.projectIds.length,
      projectIds: scope.projectIds,
    },
    counts: scoped.counts,
    myTasks: scoped.myTasks,
    scoreCard,
    dimensions: role === "user"
      ? {
        user: subject?.dimensions || {},
        attendance: subject?.attendance || {},
      }
      : {
        indexes: subject?.indexes || {},
      },
    trend: {
      direction: normalizeTrend(trendAnalytics.direction),
      points: trendAnalytics.points.map((point) => ({
        month: String(point.date).slice(0, 7),
        date: point.date,
        score: point.score,
      })),
    },
    analytics: {
      intelligence: subject,
      workspace: snapshot.workspace,
      currentUser: snapshot.currentUser,
      users: snapshot.users,
      teams: snapshot.teams,
      projects: snapshot.projects,
      trend: trendAnalytics,
      historyMaterialization,
    },
    visualizations,
    topOverdue: scoped.topOverdue,
    projectHealth: scopedProjects,
    healthScore: snapshot.workspace?.score ?? null,
    executiveSummary,
    forecast,
  };
}

export async function getDashboardExecutiveDetailFromIntelligence({ workspaceId, userId, role, range = "30d" }) {
  const overview = await getDashboardOverviewFromIntelligence({ workspaceId, userId, role, range });
  const subject = overview.analytics?.intelligence || overview.analytics?.workspace || {};

  return {
    month: overview.month,
    dashboardRange: overview.dashboardRange,
    role,
    scope: overview.scope,
    reflectiveSummary: {
      headline: overview.executiveSummary?.headline || "Executive intelligence update",
      narrative: overview.executiveSummary?.narrative || "",
      outlook: overview.executiveSummary?.outlook || null,
    },
    fullSummary: [
      overview.executiveSummary?.headline || "Executive intelligence update",
      overview.executiveSummary?.narrative || "",
      `Score ${subject.score || 0}/100, band ${subject.band || "N/A"}, confidence ${subject.confidence || 0}/100.`,
      `Primary strengths: ${(subject.strengths || []).slice(0, 3).join(" ") || "No dominant strength detected yet."}`,
      `Primary concerns: ${(subject.concerns || []).slice(0, 3).join(" ") || "No concentrated concern detected yet."}`,
      `Outlook: ${overview.forecast?.reasoning || "Outlook context is unavailable."}`,
    ].join(" "),
    reasoning: [
      `Source: enterprise intelligence repositories, calculation version ${subject.calculationVersion || "unknown"}.`,
      `Drivers: ${(subject.drivers || []).join(" ") || "No driver detail available."}`,
      `Indicators: ${(subject.indicators || []).map((item) => item.label || item.type).join(", ") || "none"}.`,
    ],
    priorities: overview.executiveSummary?.priorities || [],
    recommendations: overview.executiveSummary?.priorities || [],
    strengths: subject.strengths || [],
    risks: subject.concerns || [],
    forecast: overview.forecast,
    summaryPersistence: overview.executiveSummary?.persistence || null,
    summaryBucket: overview.executiveSummary?.summaryBucket || null,
    metrics: {
      counts: overview.counts,
      scoreCard: overview.scoreCard,
      dimensions: overview.dimensions,
      trend: overview.trend,
      healthScore: overview.healthScore,
      intelligence: subject,
      historyMaterialization: overview.analytics?.historyMaterialization || null,
    },
  };
}

export default {
  getDashboardOverviewFromIntelligence,
  getDashboardExecutiveDetailFromIntelligence,
};
