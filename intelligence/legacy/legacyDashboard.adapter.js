import pool from "../../db.js";
import {
  buildExecutiveSummary,
  computeAttendanceScore,
  computeProductivityScore,
  computeUnifiedScore,
  getScoreBand,
} from "../../services/dashboardScore.engine.js";

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function trendDirection(points = []) {
  if (!Array.isArray(points) || points.length < 2) return "stable";
  const delta = Number(points.at(-1)?.score || 0) - Number(points[0]?.score || 0);
  if (delta > 3) return "improving";
  if (delta < -3) return "declining";
  return "stable";
}

async function resolveScope({ workspaceId, userId, role }) {
  if (role === "admin") {
    const { rows } = await pool.query(
      `SELECT id, name FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return { type: "workspace", label: "Workspace", projectIds: rows.map((row) => row.id) };
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
    ).catch(() => ({ rows: [] }));
    return { type: "managed_projects", label: "Managed Projects", projectIds: rows.map((row) => row.id) };
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.workspace_id = $1
       AND t.assigned_to = $2
     ORDER BY p.name ASC`,
    [workspaceId, userId]
  ).catch(() => ({ rows: [] }));
  return { type: "self", label: "My Work", projectIds: rows.map((row) => row.id) };
}

async function legacyScoreCard({ workspaceId, userId, role, month, projectIds, liveScoreCard }) {
  const params = [workspaceId, month];
  let where = "workspace_id = $1 AND month = $2";

  if (role === "user") {
    params.push(userId);
    where += " AND user_id = $3";
  } else if (role === "manager") {
    const { rows } = await pool.query(
      `SELECT DISTINCT assigned_to AS user_id
       FROM tasks
       WHERE workspace_id = $1
         AND project_id = ANY($2::uuid[])
         AND assigned_to IS NOT NULL`,
      [workspaceId, projectIds]
    ).catch(() => ({ rows: [] }));
    const userIds = [...new Set([userId, ...rows.map((row) => row.user_id)].filter(Boolean))];
    if (!userIds.length) return liveScoreCard;
    params.push(userIds);
    where += " AND user_id = ANY($3::uuid[])";
  }

  const { rows } = await pool.query(
    `SELECT
       ROUND(AVG(score), 2) AS unified_score,
       ROUND(AVG((breakdown->>'productivityScore')::numeric), 2) AS productivity_score,
       ROUND(AVG((breakdown->>'attendanceScore')::numeric), 2) AS attendance_score
     FROM workspace_monthly_scores
     WHERE ${where}`,
    params
  ).catch(() => ({ rows: [] }));

  const row = rows[0];
  if (row?.unified_score == null) return liveScoreCard;
  const unifiedScore = Number(row.unified_score) || 0;
  return {
    unifiedScore,
    productivityScore: Number(row.productivity_score) || 0,
    attendanceScore: Number(row.attendance_score) || 0,
    band: getScoreBand(unifiedScore),
  };
}

export async function getLegacyDashboardOverview({ workspaceId, userId, role }) {
  const scope = await resolveScope({ workspaceId, userId, role });
  const month = currentMonth();
  const projectIds = scope.projectIds;

  const hasScopedProjects = projectIds.length > 0;
  const scopedTaskFilter = hasScopedProjects
    ? "t.workspace_id = $1 AND t.project_id = ANY($2::uuid[])"
    : "t.workspace_id = $1 AND FALSE";
  const scopedParams = hasScopedProjects ? [workspaceId, projectIds] : [workspaceId];
  const assignedParamIndex = scopedParams.length + 1;
  const assignedClause = role === "user" ? `AND t.assigned_to = $${assignedParamIndex}` : "";
  const scopedParamsMaybeUser = role === "user" ? [...scopedParams, userId] : scopedParams;
  const projectScopeParams = [workspaceId, projectIds];

  const [
    { rows: summaryRows },
    { rows: myRows },
    { rows: overdueRows },
    { rows: projectRows },
    { rows: productivityRows },
    { rows: attendanceRows },
    { rows: trendRows },
    { rows: healthRows },
  ] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_tasks,
         COUNT(*) FILTER (WHERE t.status = 'pending')::int AS pending_tasks,
         COUNT(*) FILTER (WHERE t.status IN ('in-progress', 'in_progress'))::int AS in_progress_tasks,
         COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
         COUNT(*) FILTER (
           WHERE t.due_date IS NOT NULL
             AND t.status NOT IN ('completed', 'cancelled')
             AND t.due_date < NOW()::date
         )::int AS overdue_tasks
       FROM tasks t
       WHERE ${scopedTaskFilter} ${assignedClause}`,
      scopedParamsMaybeUser
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE due_date IS NOT NULL
             AND status NOT IN ('completed', 'cancelled')
             AND due_date < NOW()::date
         )::int AS overdue,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM tasks
       WHERE workspace_id = $1
         AND assigned_to = $2`,
      [workspaceId, userId]
    ),
    pool.query(
      `SELECT t.id, t.project_id, p.name AS project_name, t.task, t.status, t.priority, t.due_date,
              GREATEST(1, (NOW()::date - t.due_date::date))::int AS overdue_days
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE ${scopedTaskFilter}
         AND t.status NOT IN ('completed', 'cancelled')
         AND t.due_date IS NOT NULL
         AND t.due_date < NOW()::date
         ${assignedClause}
       ORDER BY overdue_days DESC, t.due_date ASC
       LIMIT 8`,
      scopedParamsMaybeUser
    ),
    pool.query(
      `SELECT p.id AS project_id, p.name AS project_name,
              COUNT(t.id)::int AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
              COUNT(t.id) FILTER (
                WHERE t.status NOT IN ('completed', 'cancelled')
                  AND t.due_date IS NOT NULL
                  AND t.due_date < NOW()::date
              )::int AS overdue_tasks,
              ROUND(CASE WHEN COUNT(t.id) = 0 THEN 0 ELSE
                (COUNT(t.id) FILTER (WHERE t.status = 'completed')::numeric / COUNT(t.id)::numeric) * 100
              END, 2) AS completion_rate
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id AND t.workspace_id = $1
       WHERE p.workspace_id = $1
         AND p.id = ANY($2::uuid[])
       GROUP BY p.id, p.name
       ORDER BY completion_rate DESC, overdue_tasks ASC
       LIMIT 10`,
      projectScopeParams
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_tasks,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
         COUNT(*) FILTER (
           WHERE status = 'completed'
             AND due_date IS NOT NULL
             AND completed_at IS NOT NULL
             AND completed_at > due_date
         )::int AS late_completions,
         COUNT(*) FILTER (
           WHERE status NOT IN ('completed', 'cancelled')
             AND due_date IS NOT NULL
             AND due_date < NOW()::date
         )::int AS active_overdue,
         COUNT(*) FILTER (WHERE status IN ('in-progress', 'in_progress'))::int AS in_progress
       FROM tasks t
       WHERE ${scopedTaskFilter} ${assignedClause}`,
      scopedParamsMaybeUser
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(signed_in_minutes), 0)::int AS signed_in_minutes,
         COALESCE(SUM(available_minutes), 0)::int AS available_minutes,
         COALESCE(SUM(screen_on_minutes), 0)::int AS screen_on_minutes,
         COALESCE(SUM(screen_off_minutes), 0)::int AS screen_off_minutes,
         COUNT(DISTINCT date)::int AS observed_days,
         COUNT(DISTINCT CASE WHEN signed_in_minutes >= 360 THEN date END)::int AS present_days
       FROM attendance_daily
       WHERE workspace_id = $1
         AND date >= NOW()::date - INTERVAL '30 days'
         ${role === "user" ? "AND user_id = $2" : ""}`,
      role === "user" ? [workspaceId, userId] : [workspaceId]
    ).catch(() => ({ rows: [{}] })),
    pool.query(
      role === "user"
        ? `SELECT month, score FROM workspace_monthly_scores WHERE workspace_id = $1 AND user_id = $2 ORDER BY month ASC LIMIT 6`
        : `SELECT month, ROUND(AVG(score), 2) AS score FROM workspace_monthly_scores WHERE workspace_id = $1 GROUP BY month ORDER BY month ASC LIMIT 6`,
      role === "user" ? [workspaceId, userId] : [workspaceId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT health_score FROM workspace_health WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    ).catch(() => ({ rows: [] })),
  ]);

  const counts = {
    totalProjects: projectIds.length,
    totalTasks: Number(summaryRows[0]?.total_tasks || 0),
    pendingTasks: Number(summaryRows[0]?.pending_tasks || 0),
    inProgressTasks: Number(summaryRows[0]?.in_progress_tasks || 0),
    completedTasks: Number(summaryRows[0]?.completed_tasks || 0),
    overdueTasks: Number(summaryRows[0]?.overdue_tasks || 0),
  };
  const productivity = computeProductivityScore({
    totalTasks: productivityRows[0]?.total_tasks,
    completedTasks: productivityRows[0]?.completed_tasks,
    lateCompletions: productivityRows[0]?.late_completions,
    activeOverdue: productivityRows[0]?.active_overdue,
    inProgress: productivityRows[0]?.in_progress,
  });
  const attendance = computeAttendanceScore({
    signedInMinutes: attendanceRows[0]?.signed_in_minutes,
    availableMinutes: attendanceRows[0]?.available_minutes,
    screenOnMinutes: attendanceRows[0]?.screen_on_minutes,
    screenOffMinutes: attendanceRows[0]?.screen_off_minutes,
    observedDays: attendanceRows[0]?.observed_days,
    presentDays: attendanceRows[0]?.present_days,
  });
  const unifiedScore = computeUnifiedScore(productivity.score, attendance.score);
  const liveScoreCard = {
    unifiedScore,
    productivityScore: productivity.score,
    attendanceScore: attendance.score,
    band: getScoreBand(unifiedScore),
  };
  const scoreCard = await legacyScoreCard({
    workspaceId,
    userId,
    role,
    month,
    projectIds,
    liveScoreCard,
  });
  const trend = {
    direction: trendDirection(trendRows),
    points: trendRows.map((row) => ({ month: row.month, score: Number(row.score) || 0 })),
  };
  const projectHealth = projectRows.map((project) => {
    const completionRate = Number(project.completion_rate) || 0;
    const overduePenalty = Math.min(35, (Number(project.overdue_tasks) || 0) * 5);
    return {
      projectId: project.project_id,
      projectName: project.project_name,
      totalTasks: Number(project.total_tasks) || 0,
      completedTasks: Number(project.completed_tasks) || 0,
      overdueTasks: Number(project.overdue_tasks) || 0,
      completionRate,
      score: Math.max(0, Math.min(100, Math.round(0.75 * completionRate + 25 - overduePenalty))),
    };
  });
  const executiveSummary = buildExecutiveSummary({
    role,
    scopeLabel: scope.label,
    counts,
    scoreCard,
    trend,
    topOverdue: overdueRows,
  });

  return {
    role,
    month,
    source: "legacy_scoring_rollback",
    scope: {
      type: scope.type,
      label: scope.label,
      projectCount: projectIds.length,
      projectIds,
    },
    counts,
    myTasks: {
      total: Number(myRows[0]?.total || 0),
      overdue: Number(myRows[0]?.overdue || 0),
      completed: Number(myRows[0]?.completed || 0),
    },
    scoreCard,
    dimensions: {
      productivity: productivity.dimensions,
      attendance: attendance.dimensions,
    },
    trend,
    topOverdue: overdueRows,
    projectHealth,
    healthScore: healthRows[0]?.health_score != null
      ? Number(healthRows[0].health_score)
      : null,
    executiveSummary,
  };
}

export async function getLegacyDashboardExecutiveDetail({ workspaceId, userId, role }) {
  const overview = await getLegacyDashboardOverview({ workspaceId, userId, role });
  const summary = overview.executiveSummary || {};
  return {
    month: overview.month,
    role,
    source: "legacy_scoring_rollback",
    scope: overview.scope,
    reflectiveSummary: {
      headline: summary.headline || "Legacy executive performance update",
      narrative: summary.narrative || "",
    },
    fullSummary: [
      summary.headline || "Legacy executive performance update",
      summary.narrative || "",
      `Legacy rollback score ${overview.scoreCard?.unifiedScore || 0}/100 from monthly/task/attendance fallback evidence.`,
    ].join(" "),
    reasoning: [
      "Source: legacy scoring rollback adapter.",
      `Trend points: ${(overview.trend?.points || []).map((point) => `${point.month}:${point.score}`).join(", ") || "none"}.`,
    ],
    priorities: summary.priorities || [],
    recommendations: summary.priorities || [],
    strengths: summary.strengths || [],
    risks: summary.risks || [],
    metrics: {
      counts: overview.counts,
      scoreCard: overview.scoreCard,
      dimensions: overview.dimensions,
      trend: overview.trend,
      healthScore: overview.healthScore,
    },
  };
}

export default {
  getLegacyDashboardExecutiveDetail,
  getLegacyDashboardOverview,
};
