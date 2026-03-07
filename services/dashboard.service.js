import pool from "../db.js";
import {
  buildExecutiveSummary,
  computeAttendanceScore,
  computeProductivityScore,
  computeUnifiedScore,
  getScoreBand,
} from "./dashboardScore.engine.js";

function getCurrentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function getTrendDirection(points) {
  if (!Array.isArray(points) || points.length < 2) return "stable";
  const first = Number(points[0]?.score || 0);
  const last = Number(points[points.length - 1]?.score || 0);
  const delta = last - first;
  if (delta > 3) return "improving";
  if (delta < -3) return "declining";
  return "stable";
}

async function resolveScope({ workspaceId, userId, role }) {
  if (role === "admin") {
    const { rows } = await pool.query(
      `SELECT id, name, added_by FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return {
      scopeType: "workspace",
      scopeLabel: "Workspace",
      projects: rows,
      projectIds: rows.map((p) => p.id),
    };
  }

  if (role === "manager") {
    const { rows } = await pool.query(
      `
      SELECT id, name, added_by
      FROM projects
      WHERE workspace_id = $1
        AND added_by = $2
      ORDER BY created_at DESC
      `,
      [workspaceId, userId]
    );
    return {
      scopeType: "managed_projects",
      scopeLabel: "Managed Projects",
      projects: rows,
      projectIds: rows.map((p) => p.id),
    };
  }

  const { rows } = await pool.query(
    `
    SELECT DISTINCT p.id, p.name, p.added_by
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = $1
      AND t.assigned_to = $2
    ORDER BY p.name ASC
    `,
    [workspaceId, userId]
  );

  return {
    scopeType: "self",
    scopeLabel: "My Work",
    projects: rows,
    projectIds: rows.map((p) => p.id),
  };
}

function withProjectScope(baseWhere, params, projectIds, startIdx) {
  const whereParts = [baseWhere];
  let idx = startIdx;

  if (Array.isArray(projectIds) && projectIds.length > 0) {
    whereParts.push(`t.project_id = ANY($${idx})`);
    params.push(projectIds);
    idx += 1;
  } else {
    whereParts.push("FALSE");
  }

  return {
    whereSql: whereParts.join(" AND "),
    nextIdx: idx,
  };
}

export async function getDashboardOverview({ workspaceId, userId, role }) {
  const scope = await resolveScope({ workspaceId, userId, role });
  const month = getCurrentMonthKey();

  if (scope.projectIds.length === 0) {
    const emptyScore = { productivityScore: 0, attendanceScore: 0, unifiedScore: 0, band: "Watch" };
    return {
      role,
      month,
      scope: {
        type: scope.scopeType,
        label: scope.scopeLabel,
        projectCount: 0,
        projectIds: [],
      },
      counts: {
        totalProjects: 0,
        totalTasks: 0,
        pendingTasks: 0,
        inProgressTasks: 0,
        completedTasks: 0,
        overdueTasks: 0,
      },
      myTasks: {
        total: 0,
        overdue: 0,
        completed: 0,
      },
      scoreCard: emptyScore,
      dimensions: {
        productivity: {},
        attendance: {},
      },
      trend: {
        direction: "stable",
        points: [],
      },
      topOverdue: [],
      projectHealth: [],
      executiveSummary: buildExecutiveSummary({
        role,
        scopeLabel: scope.scopeLabel,
        counts: {},
        scoreCard: emptyScore,
        trend: { direction: "stable" },
        topOverdue: [],
      }),
    };
  }

  const baseParams = [workspaceId];
  const scopeInfo = withProjectScope("t.workspace_id = $1", baseParams, scope.projectIds, 2);

  let assignedClause = "";
  if (role === "user") {
    assignedClause = ` AND t.assigned_to = $${scopeInfo.nextIdx}`;
    baseParams.push(userId);
  }

  const summaryQuery = `
    SELECT
      COUNT(*)::int AS total_tasks,
      COUNT(*) FILTER (WHERE t.status = 'pending')::int AS pending_tasks,
      COUNT(*) FILTER (WHERE t.status = 'in-progress')::int AS in_progress_tasks,
      COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
      COUNT(*) FILTER (
        WHERE t.due_date IS NOT NULL
          AND t.status NOT IN ('completed', 'cancelled')
          AND t.due_date < NOW()::date
      )::int AS overdue_tasks
    FROM tasks t
    WHERE ${scopeInfo.whereSql}
      ${assignedClause}
  `;

  const myTasksQuery = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE t.due_date IS NOT NULL
          AND t.status NOT IN ('completed', 'cancelled')
          AND t.due_date < NOW()::date
      )::int AS overdue,
      COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed
    FROM tasks t
    WHERE t.workspace_id = $1
      AND t.project_id = ANY($2)
      AND t.assigned_to = $3
  `;

  const overdueQuery = `
    SELECT
      t.id,
      t.project_id,
      p.name AS project_name,
      t.task,
      t.status,
      t.priority,
      t.due_date,
      GREATEST(1, (NOW()::date - t.due_date::date))::int AS overdue_days
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = $1
      AND t.project_id = ANY($2)
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.due_date IS NOT NULL
      AND t.due_date < NOW()::date
      ${role === "user" ? "AND t.assigned_to = $3" : ""}
    ORDER BY overdue_days DESC, t.due_date ASC
    LIMIT 8
  `;

  const projectHealthQuery = `
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      COUNT(t.id)::int AS total_tasks,
      COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
      COUNT(t.id) FILTER (
        WHERE t.status NOT IN ('completed', 'cancelled')
          AND t.due_date IS NOT NULL
          AND t.due_date < NOW()::date
      )::int AS overdue_tasks,
      ROUND(
        CASE
          WHEN COUNT(t.id) = 0 THEN 0
          ELSE (COUNT(t.id) FILTER (WHERE t.status = 'completed')::numeric / COUNT(t.id)::numeric) * 100
        END
      , 2) AS completion_rate
    FROM projects p
    LEFT JOIN tasks t
      ON t.project_id = p.id
      AND t.workspace_id = $1
      ${role === "user" ? "AND t.assigned_to = $3" : ""}
    WHERE p.workspace_id = $1
      AND p.id = ANY($2)
    GROUP BY p.id, p.name
    ORDER BY completion_rate DESC, overdue_tasks ASC
    LIMIT 10
  `;

  const productivityQuery = `
    SELECT
      COUNT(*)::int AS total_tasks,
      COUNT(*) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
      COUNT(*) FILTER (
        WHERE t.status = 'completed'
          AND t.due_date IS NOT NULL
          AND t.completed_at IS NOT NULL
          AND t.completed_at > t.due_date
      )::int AS late_completions,
      COUNT(*) FILTER (
        WHERE t.status NOT IN ('completed', 'cancelled')
          AND t.due_date IS NOT NULL
          AND t.due_date < NOW()::date
      )::int AS active_overdue,
      COUNT(*) FILTER (WHERE t.status = 'in-progress')::int AS in_progress
    FROM tasks t
    WHERE ${scopeInfo.whereSql}
      ${assignedClause}
  `;

  const attendanceBase = [workspaceId];
  let attendanceWhere = `workspace_id = $1 AND date >= NOW()::date - INTERVAL '30 days'`;
  if (role === "user") {
    attendanceWhere += ` AND user_id = $2`;
    attendanceBase.push(userId);
  } else if (role === "manager") {
    const { rows: scopeUsers } = await pool.query(
      `
      SELECT DISTINCT t.assigned_to AS user_id
      FROM tasks t
      WHERE t.workspace_id = $1
        AND t.project_id = ANY($2)
        AND t.assigned_to IS NOT NULL
      `,
      [workspaceId, scope.projectIds]
    );
    const userIds = Array.from(new Set([userId, ...scopeUsers.map((u) => u.user_id)]));
    attendanceWhere += ` AND user_id = ANY($2)`;
    attendanceBase.push(userIds);
  }

  const attendanceQuery = `
    SELECT
      COALESCE(SUM(signed_in_minutes), 0)::int AS signed_in_minutes,
      COALESCE(SUM(available_minutes), 0)::int AS available_minutes,
      COALESCE(SUM(screen_on_minutes), 0)::int AS screen_on_minutes,
      COALESCE(SUM(screen_off_minutes), 0)::int AS screen_off_minutes,
      COUNT(DISTINCT date)::int AS observed_days,
      COUNT(DISTINCT CASE WHEN signed_in_minutes >= 360 THEN date END)::int AS present_days
    FROM attendance_daily
    WHERE ${attendanceWhere}
  `;

  const trendQuery = role === "admin"
    ? `
      SELECT month, ROUND(AVG(score), 2) AS score
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
      GROUP BY month
      ORDER BY month ASC
      LIMIT 6
    `
    : role === "manager"
      ? `
        SELECT month, ROUND(AVG(score), 2) AS score
        FROM workspace_project_monthly_scores
        WHERE workspace_id = $1
          AND project_id = ANY($2)
        GROUP BY month
        ORDER BY month ASC
        LIMIT 6
      `
      : `
        SELECT month, score
        FROM workspace_monthly_scores
        WHERE workspace_id = $1
          AND user_id = $2
        ORDER BY month ASC
        LIMIT 6
      `;

  const trendParams = role === "admin"
    ? [workspaceId]
    : role === "manager"
      ? [workspaceId, scope.projectIds]
      : [workspaceId, userId];

  const healthQuery = `
    SELECT health_score
    FROM workspace_health
    WHERE workspace_id = $1
    LIMIT 1
  `;

  const sharedParamsWithUser = [workspaceId, scope.projectIds, userId];
  const sharedParamsNoUser = [workspaceId, scope.projectIds];

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
    pool.query(summaryQuery, baseParams),
    pool.query(myTasksQuery, sharedParamsWithUser),
    pool.query(overdueQuery, role === "user" ? sharedParamsWithUser : sharedParamsNoUser),
    pool.query(projectHealthQuery, role === "user" ? sharedParamsWithUser : sharedParamsNoUser),
    pool.query(productivityQuery, baseParams),
    pool.query(attendanceQuery, attendanceBase),
    pool.query(trendQuery, trendParams),
    pool.query(healthQuery, [workspaceId]),
  ]);

  const counts = {
    totalProjects: scope.projectIds.length,
    totalTasks: Number(summaryRows[0]?.total_tasks || 0),
    pendingTasks: Number(summaryRows[0]?.pending_tasks || 0),
    inProgressTasks: Number(summaryRows[0]?.in_progress_tasks || 0),
    completedTasks: Number(summaryRows[0]?.completed_tasks || 0),
    overdueTasks: Number(summaryRows[0]?.overdue_tasks || 0),
  };

  const myTasks = {
    total: Number(myRows[0]?.total || 0),
    overdue: Number(myRows[0]?.overdue || 0),
    completed: Number(myRows[0]?.completed || 0),
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
  const trend = {
    direction: getTrendDirection(trendRows),
    points: trendRows.map((r) => ({ month: r.month, score: Number(r.score) || 0 })),
  };

  const scoreCard = {
    unifiedScore,
    productivityScore: productivity.score,
    attendanceScore: attendance.score,
    band: getScoreBand(unifiedScore),
  };

  const executiveSummary = buildExecutiveSummary({
    role,
    scopeLabel: scope.scopeLabel,
    counts,
    scoreCard,
    trend,
    topOverdue: overdueRows,
  });

  const projectHealth = projectRows.map((p) => {
    const completion = Number(p.completion_rate) || 0;
    const overduePenalty = Math.min(35, (Number(p.overdue_tasks) || 0) * 5);
    const score = Math.max(0, Math.min(100, Math.round(0.75 * completion + 25 - overduePenalty)));
    return {
      projectId: p.project_id,
      projectName: p.project_name,
      totalTasks: Number(p.total_tasks) || 0,
      completedTasks: Number(p.completed_tasks) || 0,
      overdueTasks: Number(p.overdue_tasks) || 0,
      completionRate: completion,
      score,
    };
  });

  return {
    role,
    month,
    scope: {
      type: scope.scopeType,
      label: scope.scopeLabel,
      projectCount: scope.projectIds.length,
      projectIds: scope.projectIds,
    },
    counts,
    myTasks,
    scoreCard,
    dimensions: {
      productivity: productivity.dimensions,
      attendance: attendance.dimensions,
    },
    trend,
    topOverdue: overdueRows,
    projectHealth,
    healthScore: Number(healthRows[0]?.health_score || 70),
    executiveSummary,
  };
}

export async function getDashboardExecutiveDetail({ workspaceId, userId, role }) {
  const overview = await getDashboardOverview({ workspaceId, userId, role });

  const summary = overview.executiveSummary || {};
  const counts = overview.counts || {};
  const scoreCard = overview.scoreCard || {};
  const trend = overview.trend || {};
  const productivity = overview.dimensions?.productivity || {};
  const attendance = overview.dimensions?.attendance || {};
  const topProject = overview.projectHealth?.[0];
  const topOverdue = overview.topOverdue?.[0];

  const fullSummary = [
    `${summary.headline || "Executive performance update"}.`,
    `Scope: ${overview.scope?.label || "N/A"} (${overview.scope?.projectCount || 0} projects).`,
    `Current workload: ${counts.totalTasks || 0} tasks, ${counts.completedTasks || 0} completed, ${counts.inProgressTasks || 0} in progress, ${counts.pendingTasks || 0} pending, ${counts.overdueTasks || 0} overdue.`,
    `Unified score is ${scoreCard.unifiedScore || 0}/100 (${scoreCard.band || "N/A"}), composed of productivity ${scoreCard.productivityScore || 0} and attendance ${scoreCard.attendanceScore || 0}.`,
    `Trend direction is ${trend.direction || "stable"} with ${Array.isArray(trend.points) ? trend.points.length : 0} months of observed score points.`,
    topProject
      ? `Best current project execution is "${topProject.projectName}" with score ${topProject.score}, completion rate ${topProject.completionRate}%, and ${topProject.overdueTasks} overdue tasks.`
      : "No project-level benchmark is available for the selected scope.",
    topOverdue
      ? `Highest urgency task is "${topOverdue.task}" in ${topOverdue.project_name}, overdue by ${topOverdue.overdue_days} day(s).`
      : "There are no overdue tasks in current scope.",
    `Primary improvement levers are: ${(summary.priorities || []).slice(0, 3).join(" ") || "No immediate interventions required."}`,
  ].join(" ");

  const reasoning = [
    `Productivity evidence: completion rate ${productivity.completionRate || 0}, timeliness ${productivity.timeliness || 0}, backlog control ${productivity.backlogControl || 0}, focus flow ${productivity.focusFlow || 0}.`,
    `Attendance evidence: availability ratio ${attendance.availabilityRatio || 0}, consistency ${attendance.consistency || 0}, focus presence ${attendance.focusPresence || 0}.`,
    `Risk concentration is inferred from overdue count (${counts.overdueTasks || 0}) and in-progress pressure (${counts.inProgressTasks || 0}).`,
    `Trend confidence is based on recorded monthly points: ${(trend.points || []).map((p) => `${p.month}:${p.score}`).join(", ") || "none"}.`,
  ];

  return {
    month: overview.month,
    role,
    scope: overview.scope,
    reflectiveSummary: {
      headline: summary.headline || "Executive performance update",
      narrative: summary.narrative || "",
    },
    fullSummary,
    reasoning,
    priorities: summary.priorities || [],
    recommendations: summary.priorities || [],
    strengths: summary.strengths || [],
    risks: summary.risks || [],
    metrics: {
      counts,
      scoreCard,
      dimensions: overview.dimensions || {},
      trend,
      healthScore: overview.healthScore,
    },
  };
}
