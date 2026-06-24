import pool from "../../db.js";
import { getUnifiedIntelligenceSnapshot } from "../engine/unifiedIntelligence.engine.js";
import {
  buildDashboardVisualizations,
  dashboardRangeMeta,
} from "./dashboardChartContract.service.js";
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

  const trendSeries = await getHistoricalSeries({
    workspaceId,
    scopeType: role === "user" ? "user" : role === "manager" ? "team" : "workspace",
    subjectKey: role === "user" ? String(userId) : role === "manager" ? `manager:${userId}` : String(workspaceId),
    range: rangeMeta.value,
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
    },
    visualizations: buildDashboardVisualizations({
      role,
      trendSeries,
      snapshot,
      scopedProjects,
      rangeMeta,
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
