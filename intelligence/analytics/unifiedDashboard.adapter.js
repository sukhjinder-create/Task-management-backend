import pool from "../../db.js";
import { getUnifiedIntelligenceSnapshot } from "../engine/unifiedIntelligence.engine.js";
import { buildTrendAnalytics, getHistoricalSeries } from "./historicalAnalytics.service.js";

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

function chartLabel(point, index) {
  if (point?.date) return String(point.date).slice(5, 10);
  if (point?.month) return point.month;
  return `P${index + 1}`;
}

function metricFromSnapshot(point, path, fallback = null) {
  const parts = path.split(".");
  let current = point?.payload || {};
  for (const part of parts) {
    current = current?.[part];
    if (current == null) return fallback;
  }
  const value = Number(current);
  return Number.isFinite(value) ? value : fallback;
}

function chartValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function chartAxis() {
  return {
    x: { dataKey: "label", type: "category" },
    y: { dataKey: "value", domain: [0, 100] },
  };
}

function chartSeries(metric) {
  return [
    {
      id: "value",
      label: metric,
      dataKey: "value",
    },
  ];
}

function lineChart({ key, title, metric, points, scope = null }) {
  return {
    id: key,
    key,
    title,
    type: "line",
    dataKey: "value",
    metric,
    source: "intelligence_snapshots",
    scope: scope || { type: "dashboard_intelligence" },
    axis: chartAxis(),
    series: chartSeries(metric),
    data: (points || []).map((point, index) => ({
      label: chartLabel(point, index),
      date: point.date,
      value: chartValue(point.value),
    })),
  };
}

function barChart({ key, title, metric, source, rows, scope = null }) {
  return {
    id: key,
    key,
    title,
    type: "bar",
    dataKey: "value",
    metric,
    source,
    scope: scope || { type: "dashboard_intelligence" },
    axis: chartAxis(),
    series: chartSeries(metric),
    data: (rows || []).map((row) => ({
      label: row.label,
      value: chartValue(row.value),
    })),
  };
}

function historicalPoints(series = [], selector) {
  return series.map((point, index) => ({
    date: point.date,
    label: chartLabel(point, index),
    value: selector(point),
  }));
}

function topRows(items = [], labelKey, valueSelector, limit = 8) {
  return items
    .map((item) => ({
      label: item?.[labelKey] || item?.managerName || item?.projectName || item?.username || item?.teamKey || "Item",
      value: valueSelector(item),
    }))
    .filter((row) => row.label)
    .slice(0, limit);
}

function buildVisualizations({ role, trendSeries, snapshot, scopedProjects }) {
  const scoreTrend = historicalPoints(trendSeries, (point) => Number(point.score) || 0);
  const projectRows = topRows(scopedProjects, "projectName", (project) => project.score);
  const allProjectRows = topRows(snapshot.projects, "projectName", (project) => project.score);
  const teamRows = topRows(snapshot.teams, "managerName", (team) => team.score);
  const scope = { type: "role_dashboard", role, range: "30d" };

  if (role === "admin") {
    return {
      charts: [
        lineChart({ key: "workspace_health_trends", title: "Workspace Health Trends", metric: "Workspace Health", points: scoreTrend, scope }),
        lineChart({
          key: "productivity_trends",
          title: "Productivity Trends",
          metric: "Productivity",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "indexes.productivityIndex")),
          scope,
        }),
        lineChart({
          key: "risk_trends",
          title: "Risk Trends",
          metric: "Risk Probability",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "risk.probability")),
          scope,
        }),
        barChart({ key: "team_comparisons", title: "Team Comparisons", metric: "Team Score", source: "team_intelligence", rows: teamRows, scope }),
        barChart({ key: "project_portfolio_comparisons", title: "Project Portfolio Comparisons", metric: "Project Score", source: "project_intelligence", rows: allProjectRows, scope }),
        barChart({ key: "department_comparisons", title: "Department Comparisons", metric: "Team Scope Score", source: "team_intelligence", rows: teamRows, scope }),
      ],
    };
  }

  if (role === "manager") {
    return {
      charts: [
        barChart({ key: "assigned_project_performance", title: "Assigned Project Performance", metric: "Project Score", source: "project_intelligence", rows: projectRows, scope }),
        lineChart({
          key: "team_delivery_trends",
          title: "Team Delivery Trends",
          metric: "Delivery Reliability",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "indexes.deliveryReliabilityIndex")),
          scope,
        }),
        lineChart({
          key: "team_risk_trends",
          title: "Team Risk Trends",
          metric: "Risk Probability",
          points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "risk.probability")),
          scope,
        }),
        barChart({
          key: "sprint_progress_trends",
          title: "Sprint Progress Trends",
          metric: "Completion Rate",
          source: "project_intelligence",
          rows: topRows(scopedProjects, "projectName", (project) => project.completionRate),
          scope,
        }),
        barChart({
          key: "completion_forecasts",
          title: "Completion Forecasts",
          metric: "Completion Confidence",
          source: "project_intelligence",
          rows: topRows(scopedProjects, "projectName", (project) => project.completionConfidence),
          scope,
        }),
      ],
    };
  }

  return {
    charts: [
      lineChart({ key: "personal_performance_trends", title: "Personal Performance Trends", metric: "Personal Score", points: scoreTrend, scope }),
      lineChart({
        key: "workload_trends",
        title: "Workload Trends",
        metric: "Sustainability",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "dimensions.workSustainability.score")),
        scope,
      }),
      lineChart({
        key: "delivery_trends",
        title: "Delivery Trends",
        metric: "Delivery Effectiveness",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "dimensions.deliveryEffectiveness.score")),
        scope,
      }),
      lineChart({
        key: "task_completion_trends",
        title: "Task Completion Trends",
        metric: "Commitment Completion",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "dimensions.executionReliability.metrics.commitmentCompletion")),
        scope,
      }),
      lineChart({
        key: "personal_risk_trends",
        title: "Personal Risk Trends",
        metric: "Risk Probability",
        points: historicalPoints(trendSeries, (point) => metricFromSnapshot(point, "risk.probability")),
        scope,
      }),
    ],
  };
}

function buildExecutiveSummary({ role, scopeLabel, intelligence, counts, topOverdue }) {
  const subject = intelligence || {};
  const topRiskTask = topOverdue?.[0];
  const score = subject.score || 0;
  const band = subject.band || "Unavailable";
  const strengths = subject.strengths || [];
  const concerns = subject.concerns || [];
  const priorities = [
    ...(concerns.slice(0, 3)),
    "Keep intelligence snapshots current through event-driven recalculation.",
  ].slice(0, 4);

  if (role === "user") {
    return {
      headline: `${scopeLabel}: ${band} personal intelligence (${score}/100)`,
      narrative: `Your current intelligence score is ${score}/100 with ${counts.overdueTasks || 0} overdue task(s). ${concerns[0] || strengths[0] || "Keep delivery, collaboration, and sustainability signals balanced."}`,
      strengths,
      risks: concerns,
      priorities,
    };
  }

  return {
    headline: `${scopeLabel}: ${band} intelligence posture (${score}/100)`,
    narrative:
      `Current intelligence posture is ${subject.trend || "stable"}. ` +
      `The score is backed by confidence ${subject.confidence || 0}/100, ` +
      `${counts.totalTasks || 0} scoped task(s), and ${counts.overdueTasks || 0} overdue item(s). ` +
      `${topRiskTask ? `Highest urgency: "${topRiskTask.task}" (${topRiskTask.overdue_days} day(s) overdue).` : concerns[0] || strengths[0] || "No concentrated risk is currently visible."}`,
    strengths,
    risks: concerns,
    priorities,
  };
}

async function getManagerTeamSubject({ workspaceId, userId, teams }) {
  const direct = teams.find((team) => team.teamKey === `manager:${userId}`);
  if (direct) return direct;
  return teams.find((team) => team.managerId === userId) || null;
}

export async function getDashboardOverviewFromIntelligence({ workspaceId, userId, role }) {
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

  const trendSeries = await getHistoricalSeries({
    workspaceId,
    scopeType: role === "user" ? "user" : role === "manager" ? "team" : "workspace",
    subjectKey: role === "user" ? String(userId) : role === "manager" ? `manager:${userId}` : String(workspaceId),
    range: "30d",
  });
  const trendAnalytics = buildTrendAnalytics(trendSeries);

  const executiveSummary = buildExecutiveSummary({
    role,
    scopeLabel: scope.label,
    intelligence: subject,
    counts: scoped.counts,
    topOverdue: scoped.topOverdue,
  });

  return {
    role,
    month: new Date().toISOString().slice(0, 7),
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
    },
    visualizations: buildVisualizations({
      role,
      trendSeries,
      snapshot,
      scopedProjects,
    }),
    topOverdue: scoped.topOverdue,
    projectHealth: scopedProjects,
    healthScore: snapshot.workspace?.score ?? null,
    executiveSummary,
  };
}

export async function getDashboardExecutiveDetailFromIntelligence({ workspaceId, userId, role }) {
  const overview = await getDashboardOverviewFromIntelligence({ workspaceId, userId, role });
  const subject = overview.analytics?.intelligence || overview.analytics?.workspace || {};

  return {
    month: overview.month,
    role,
    scope: overview.scope,
    reflectiveSummary: {
      headline: overview.executiveSummary?.headline || "Executive intelligence update",
      narrative: overview.executiveSummary?.narrative || "",
    },
    fullSummary: [
      overview.executiveSummary?.headline || "Executive intelligence update",
      overview.executiveSummary?.narrative || "",
      `Score ${subject.score || 0}/100, band ${subject.band || "N/A"}, confidence ${subject.confidence || 0}/100.`,
      `Primary strengths: ${(subject.strengths || []).slice(0, 3).join(" ") || "No dominant strength detected yet."}`,
      `Primary concerns: ${(subject.concerns || []).slice(0, 3).join(" ") || "No concentrated concern detected yet."}`,
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
    metrics: {
      counts: overview.counts,
      scoreCard: overview.scoreCard,
      dimensions: overview.dimensions,
      trend: overview.trend,
      healthScore: overview.healthScore,
      intelligence: subject,
    },
  };
}

export default {
  getDashboardOverviewFromIntelligence,
  getDashboardExecutiveDetailFromIntelligence,
};
