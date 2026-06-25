import pool from "../db.js";
import { advancedForecast } from "../intelligence/forecast/forecast.engine.js";
import { getUnifiedIntelligenceSnapshot } from "../intelligence/engine/unifiedIntelligence.engine.js";
import { buildTrendAnalytics, getHistoricalSeries } from "../intelligence/analytics/historicalAnalytics.service.js";
import { dashboardRangeMeta } from "../intelligence/analytics/dashboardChartContract.service.js";

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function minutesSince(value) {
  if (!value) return 0;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 60000);
}

function mapLiveStatus(eventType) {
  switch (eventType) {
    case "AWS_START":
      return "aws";
    case "LUNCH_START":
      return "lunch";
    default:
      return "available";
  }
}

function buildStatusBucket(users, limit) {
  const names = users.map((u) => u.username);
  return {
    count: users.length,
    names: names.slice(0, limit),
    more: Math.max(0, users.length - limit),
  };
}

function daysOverdue(dueDate) {
  if (!dueDate) return 0;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return 0;
  const now = new Date();
  const diff = now.setHours(0, 0, 0, 0) - new Date(due).setHours(0, 0, 0, 0);
  return diff > 0 ? Math.floor(diff / (24 * 60 * 60 * 1000)) : 0;
}

function summarizeTaskRows(taskRows = []) {
  const status = {
    total: taskRows.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    overdueOpen: 0,
  };

  for (const t of taskRows) {
    const s = String(t.status || "").toLowerCase();
    if (s === "pending") status.pending += 1;
    else if (s === "in-progress") status.inProgress += 1;
    else if (s === "completed") status.completed += 1;
    else if (s === "cancelled") status.cancelled += 1;

    const isDone = s === "completed" || s === "cancelled";
    if (!isDone && t.due_date && daysOverdue(t.due_date) > 0) {
      status.overdueOpen += 1;
    }
  }

  return status;
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function rangeLabel(rangeMeta) {
  return rangeMeta?.label || rangeMeta?.value || "90D";
}

function forecastFromEnterpriseHistory({ series = [], workspace = null, rangeMeta = dashboardRangeMeta("90d") }) {
  const scores = (series || []).map((point) => Number(point.score)).filter(Number.isFinite);
  const trend = buildTrendAnalytics(series);
  const currentScore = workspace?.score ?? scores[scores.length - 1] ?? null;

  if (scores.length < 3) {
    return {
      predictedAverage: currentScore,
      trend: trend.direction === "up" ? "improving" : trend.direction === "down" ? "declining" : "stable",
      direction: trend.direction,
      delta: trend.delta,
      riskProjection: String(workspace?.risk?.level || "unknown").toLowerCase(),
      confidence: "low",
      momentum: 0,
      currentScore,
      confidenceScore: workspace?.confidence ?? null,
      range: rangeMeta,
      source: "enterprise_intelligence_current_snapshot",
      reasoning:
        `Only ${scores.length} enterprise intelligence snapshot(s) are available for ${rangeLabel(rangeMeta)}. ` +
        "The workspace answer uses the current canonical workspace intelligence posture until more persisted history is available.",
    };
  }

  const forecast = advancedForecast(scores, {
    completionRate: Number(workspace?.indexes?.deliveryConfidenceIndex || 0) / 100,
  });

  return {
    ...forecast,
    direction: trend.direction,
    delta: trend.delta,
    currentScore,
    confidenceScore: workspace?.confidence ?? null,
    range: rangeMeta,
    source: "enterprise_intelligence_snapshots",
    reasoning:
      forecast.reasoning ||
      `Forecast is derived from ${scores.length} persisted enterprise intelligence snapshot(s) for ${rangeLabel(rangeMeta)}.`,
  };
}

function summarizeSeries(series = []) {
  const trend = buildTrendAnalytics(series);
  const first = series[0] || null;
  const last = series[series.length - 1] || null;
  return {
    pointCount: series.length,
    coverageStart: first?.date || first?.snapshotDate || null,
    coverageEnd: last?.date || last?.snapshotDate || null,
    firstScore: first ? round(first.score) : null,
    lastScore: last ? round(last.score) : null,
    direction: trend.direction,
    delta: trend.delta,
    points: series.slice(-12).map((point) => ({
      date: point.date,
      score: round(point.score),
      confidence: round(point.confidence),
      snapshotDate: point.snapshotDate,
      computedAt: point.computedAt,
    })),
  };
}

async function getLatestEnterpriseSummaries({ workspaceId, limit = 5 }) {
  try {
    const { rows } = await pool.query(
      `SELECT period, summary, source_data, created_at, status
       FROM workspace_executive_summaries
       WHERE workspace_id = $1
         AND COALESCE(source_data->>'summaryKind', '') = 'dashboard_period_executive_summary'
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit]
    );

    return rows.map((row) => ({
      period: row.period,
      status: row.status,
      createdAt: toIso(row.created_at),
      summaryVersion: row.source_data?.summaryVersion || null,
      dashboardRange: row.source_data?.dashboardRange || null,
      bucket: row.source_data?.bucket || null,
      metrics: row.source_data?.payload?.metrics || row.source_data?.analysis?.score || null,
      headline: row.source_data?.payload?.headline || null,
      text: row.summary || null,
      source: "workspace_executive_summaries",
    }));
  } catch (error) {
    console.warn("Enterprise executive summaries unavailable:", error.message);
    return [];
  }
}

async function getCanonicalWorkspaceIntelligenceContext({ workspaceId }) {
  const snapshot = await getUnifiedIntelligenceSnapshot({
    workspaceId,
    role: "admin",
  });

  const ranges = ["30d", "90d", "6m", "1y", "all"];
  const rangeSeries = {};
  await Promise.all(ranges.map(async (range) => {
    const series = await getHistoricalSeries({
      workspaceId,
      scopeType: "workspace",
      subjectKey: String(workspaceId),
      range,
    });
    rangeSeries[range] = {
      range: dashboardRangeMeta(range),
      ...summarizeSeries(series),
    };
  }));

  const primaryRange = rangeSeries["90d"]?.pointCount >= 3 ? "90d" : "all";
  const primarySeries = await getHistoricalSeries({
    workspaceId,
    scopeType: "workspace",
    subjectKey: String(workspaceId),
    range: primaryRange,
  });
  const primaryRangeMeta = dashboardRangeMeta(primaryRange);

  return {
    source: "enterprise_intelligence",
    sourceOfTruth: {
      scoreHistory: "intelligence_snapshots",
      trendContext: "intelligence_snapshots",
      riskContext: "workspace_intelligence",
      forecastContext: "intelligence_snapshots + workspace_intelligence",
      summaryContext: "workspace_executive_summaries",
    },
    workspace: snapshot.workspace,
    users: (snapshot.users || []).slice(0, 20).map((user) => ({
      username: user.username,
      score: user.score,
      band: user.band,
      risk: user.risk,
      strengths: (user.strengths || []).slice(0, 3),
      concerns: (user.concerns || []).slice(0, 3),
      attendance: user.attendance ? {
        score: user.attendance.score,
        trend: user.attendance.metrics?.trend,
        reliability: user.attendance.metrics?.reliability,
        attendanceClosedThroughDate: user.attendanceClosedThroughDate,
      } : null,
    })),
    projects: (snapshot.projects || []).slice(0, 20).map((project) => ({
      projectName: project.projectName,
      score: project.score,
      band: project.band,
      indexes: project.indexes,
      risk: project.risk,
      analytics: project.analytics,
      strengths: (project.strengths || []).slice(0, 3),
      concerns: (project.concerns || []).slice(0, 3),
    })),
    teams: (snapshot.teams || []).slice(0, 20).map((team) => ({
      teamKey: team.teamKey,
      managerName: team.managerName,
      score: team.score,
      band: team.band,
      indexes: team.indexes,
      risk: team.risk,
      analytics: team.analytics,
      strengths: (team.strengths || []).slice(0, 3),
      concerns: (team.concerns || []).slice(0, 3),
    })),
    historyByRange: rangeSeries,
    scoreHistory: summarizeSeries(primarySeries).points.map((point) => point.score).filter(Number.isFinite),
    trend: buildTrendAnalytics(primarySeries),
    forecast: forecastFromEnterpriseHistory({
      series: primarySeries,
      workspace: snapshot.workspace,
      rangeMeta: primaryRangeMeta,
    }),
    executiveSummaries: await getLatestEnterpriseSummaries({ workspaceId }),
    calculationVersion: snapshot.calculationVersion,
  };
}

async function getLiveAttendanceSnapshot({
  workspaceId,
  userIds = null,
  nameLimit = 40,
  includeDetailedUsers = false,
}) {
  if (!workspaceId) {
    return {
      generatedAt: new Date().toISOString(),
      totalSignedIn: 0,
      statusCounts: { available: 0, aws: 0, lunch: 0 },
      available: { count: 0, names: [], more: 0 },
      aws: { count: 0, names: [], more: 0 },
      lunch: { count: 0, names: [], more: 0 },
      users: [],
    };
  }

  if (Array.isArray(userIds) && userIds.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      totalSignedIn: 0,
      statusCounts: { available: 0, aws: 0, lunch: 0 },
      available: { count: 0, names: [], more: 0 },
      aws: { count: 0, names: [], more: 0 },
      lunch: { count: 0, names: [], more: 0 },
      users: [],
    };
  }

  const params = [workspaceId];
  let whereSql = `
    s.workspace_id = $1
    AND s.sign_off_at IS NULL
  `;

  if (Array.isArray(userIds) && userIds.length > 0) {
    params.push(userIds);
    whereSql += ` AND s.user_id = ANY($2)`;
  }

  let rows = [];
  try {
    const result = await pool.query(
      `
      SELECT
        s.user_id,
        u.username,
        s.sign_in_at,
        COALESCE(ev.event_type, 'SIGN_IN') AS latest_event_type,
        COALESCE(ev.started_at, s.sign_in_at) AS latest_event_started_at
      FROM attendance_sessions s
      INNER JOIN users u ON u.id = s.user_id AND LOWER(u.username) != 'autopilot'
      LEFT JOIN LATERAL (
        SELECT e.event_type, e.started_at
        FROM attendance_events e
        WHERE e.session_id = s.id
        ORDER BY e.started_at DESC
        LIMIT 1
      ) ev ON TRUE
      WHERE ${whereSql}
      ORDER BY u.username ASC
      `,
      params
    );
    rows = result.rows;
  } catch (error) {
    console.warn("Live attendance snapshot unavailable:", error.message);
    return {
      generatedAt: new Date().toISOString(),
      totalSignedIn: 0,
      statusCounts: { available: 0, aws: 0, lunch: 0 },
      available: { count: 0, names: [], more: 0 },
      aws: { count: 0, names: [], more: 0 },
      lunch: { count: 0, names: [], more: 0 },
      users: [],
      unavailable: true,
    };
  }

  const detailedUsers = rows.map((r) => {
    const status = mapLiveStatus(r.latest_event_type);
    return {
      userId: r.user_id,
      username: r.username,
      status,
      statusSince: toIso(r.latest_event_started_at),
      statusMinutes: minutesSince(r.latest_event_started_at),
      signedInAt: toIso(r.sign_in_at),
    };
  });

  const availableUsers = detailedUsers.filter((u) => u.status === "available");
  const awsUsers = detailedUsers.filter((u) => u.status === "aws");
  const lunchUsers = detailedUsers.filter((u) => u.status === "lunch");

  return {
    generatedAt: new Date().toISOString(),
    totalSignedIn: detailedUsers.length,
    statusCounts: {
      available: availableUsers.length,
      aws: awsUsers.length,
      lunch: lunchUsers.length,
    },
    available: buildStatusBucket(availableUsers, nameLimit),
    aws: buildStatusBucket(awsUsers, nameLimit),
    lunch: buildStatusBucket(lunchUsers, nameLimit),
    users: includeDetailedUsers ? detailedUsers : [],
  };
}

async function getAttendanceHistorySnapshot({ workspaceId, userIds = null }) {
  const params = [workspaceId];
  let whereSql = `
    workspace_id = $1
    AND date >= NOW()::date - INTERVAL '30 days'
  `;

  if (Array.isArray(userIds) && userIds.length > 0) {
    params.push(userIds);
    whereSql += ` AND user_id = ANY($2)`;
  }

  if (Array.isArray(userIds) && userIds.length === 0) {
    return {
      windowDays: 30,
      observedUsers: 0,
      observedDays: 0,
      signedInHours: 0,
      availableHours: 0,
      awsHours: 0,
      availabilityRatio: 0,
      awsRatio: 0,
    };
  }

  let rows = [];
  try {
    const result = await pool.query(
      `
      SELECT
        COALESCE(SUM(signed_in_minutes), 0)::int AS signed_in_minutes,
        COALESCE(SUM(available_minutes), 0)::int AS available_minutes,
        COALESCE(SUM(aws_minutes), 0)::int AS aws_minutes,
        COUNT(DISTINCT user_id)::int AS observed_users,
        COUNT(DISTINCT date)::int AS observed_days
      FROM attendance_daily
      WHERE ${whereSql}
      `,
      params
    );
    rows = result.rows;
  } catch (error) {
    console.warn("Attendance history snapshot unavailable:", error.message);
    return {
      windowDays: 30,
      observedUsers: 0,
      observedDays: 0,
      signedInHours: 0,
      availableHours: 0,
      awsHours: 0,
      availabilityRatio: 0,
      awsRatio: 0,
      unavailable: true,
    };
  }

  const signedInMinutes = Number(rows[0]?.signed_in_minutes || 0);
  const availableMinutes = Number(rows[0]?.available_minutes || 0);
  const awsMinutes = Number(rows[0]?.aws_minutes || 0);

  return {
    windowDays: 30,
    observedUsers: Number(rows[0]?.observed_users || 0),
    observedDays: Number(rows[0]?.observed_days || 0),
    signedInHours: Number((signedInMinutes / 60).toFixed(1)),
    availableHours: Number((availableMinutes / 60).toFixed(1)),
    awsHours: Number((awsMinutes / 60).toFixed(1)),
    availabilityRatio: signedInMinutes > 0
      ? Number(((availableMinutes / signedInMinutes) * 100).toFixed(1))
      : 0,
    awsRatio: signedInMinutes > 0
      ? Number(((awsMinutes / signedInMinutes) * 100).toFixed(1))
      : 0,
  };
}

async function getTodaySignInsSnapshot({ workspaceId, userIds = null, nameLimit = 80 }) {
  if (!workspaceId) {
    return {
      date: new Date().toISOString().slice(0, 10),
      totalSignedInToday: 0,
      currentlySignedIn: 0,
      names: [],
      more: 0,
    };
  }

  if (Array.isArray(userIds) && userIds.length === 0) {
    return {
      date: new Date().toISOString().slice(0, 10),
      totalSignedInToday: 0,
      currentlySignedIn: 0,
      names: [],
      more: 0,
    };
  }

  const params = [workspaceId];
  let whereSql = `
    s.workspace_id = $1
    AND s.sign_in_at::date = CURRENT_DATE
  `;

  if (Array.isArray(userIds) && userIds.length > 0) {
    params.push(userIds);
    whereSql += ` AND s.user_id = ANY($2)`;
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        s.user_id,
        u.username,
        s.sign_in_at,
        s.sign_off_at
      FROM attendance_sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE ${whereSql}
      ORDER BY u.username ASC
      `,
      params
    );

    const names = rows.map((r) => r.username);
    const currentlySignedIn = rows.filter((r) => !r.sign_off_at).length;

    return {
      date: new Date().toISOString().slice(0, 10),
      totalSignedInToday: rows.length,
      currentlySignedIn,
      names: names.slice(0, nameLimit),
      more: Math.max(0, names.length - nameLimit),
    };
  } catch (error) {
    console.warn("Today sign-ins snapshot unavailable:", error.message);
    return {
      date: new Date().toISOString().slice(0, 10),
      totalSignedInToday: 0,
      currentlySignedIn: 0,
      names: [],
      more: 0,
      unavailable: true,
    };
  }
}

export async function buildAIContext({
  workspaceId,
  scope,
  entityId,
  question = ""
}) {
  const context = {
    scope,
    entityId
  };
  const includeDetailedUsers = true; // always needed for person-specific queries

  // ==========================
  // TASK CONTEXT
  // ==========================
  if (scope === "task") {

    if (!entityId) {
      throw new Error("Task ID (entityId) is required for task scope");
    }

    // First check if task exists at all
    const taskCheck = await pool.query(`
      SELECT id, workspace_id, status
      FROM tasks
      WHERE id = $1
      LIMIT 1
    `, [entityId]);

    if (!taskCheck.rows.length) {
      throw new Error(`Task with ID '${entityId}' does not exist in the database.`);
    }

    const taskWorkspaceId = taskCheck.rows[0].workspace_id;

    if (taskWorkspaceId !== workspaceId) {
      throw new Error(
        `Task belongs to a different workspace. Task workspace: '${taskWorkspaceId}', Your workspace: '${workspaceId}'. You can only query tasks within your own workspace.`
      );
    }

    // Now fetch full task details
    const taskRes = await pool.query(`
      SELECT
        t.*,
        p.name AS project_name,
        u.username AS assignee_username
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.id = $1
        AND t.workspace_id = $2
      LIMIT 1
    `, [entityId, workspaceId]);

    const task = taskRes.rows[0];

    const logs = await pool.query(`
      SELECT action_type, old_value, new_value, created_at
      FROM task_activity_logs
      WHERE task_id = $1
      ORDER BY created_at ASC
    `, [entityId]);

    context.task = task;
    context.taskFacts = {
      isOverdue: !!(task?.due_date && daysOverdue(task.due_date) > 0 && task?.status !== "completed"),
      overdueDays: daysOverdue(task?.due_date),
      dueDate: toIso(task?.due_date),
      status: task?.status || "unknown",
      priority: task?.priority || "unknown",
      assignee: task?.assignee_username || null,
      projectName: task?.project_name || null,
    };
    context.activity = logs.rows;
    context.attendance = {
      live: await getLiveAttendanceSnapshot({
        workspaceId,
        userIds: task?.assigned_to ? [task.assigned_to] : null,
        nameLimit: 20,
        includeDetailedUsers,
      }),
      todaySignIns: await getTodaySignInsSnapshot({
        workspaceId,
        userIds: task?.assigned_to ? [task.assigned_to] : null,
        nameLimit: 30,
      }),
      history30d: await getAttendanceHistorySnapshot({
        workspaceId,
        userIds: task?.assigned_to ? [task.assigned_to] : null,
      }),
    };

    return context;
  }

  // ==========================
  // PROJECT CONTEXT
  // ==========================
  if (scope === "project") {

    if (!entityId) {
      throw new Error("Project ID (entityId) is required for project scope");
    }

    // Verify project exists in workspace
    const projectCheck = await pool.query(`
      SELECT id FROM projects
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1
    `, [entityId, workspaceId]);

    if (!projectCheck.rows.length) {
      throw new Error(
        `Project not found. Either project ID '${entityId}' does not exist or it does not belong to this workspace.`
      );
    }

    const tasks = await pool.query(`
      SELECT
        t.id,
        t.task,
        t.status,
        t.priority,
        t.due_date,
        t.assigned_to,
        u.username AS assignee_username
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.project_id = $1
        AND t.workspace_id = $2
    `, [entityId, workspaceId]);

    const overdue = tasks.rows.filter(t =>
      t.due_date &&
      new Date(t.due_date) < new Date() &&
      t.status !== "completed"
    );

    context.projectTasks = tasks.rows;
    context.projectSummary = summarizeTaskRows(tasks.rows);
    context.overdueCount = overdue.length;
    context.totalTasks = tasks.rows.length;
    context.topOverdueTasks = tasks.rows
      .filter((t) => t.due_date && t.status !== "completed" && daysOverdue(t.due_date) > 0)
      .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
      .slice(0, 8)
      .map((t) => ({
        taskId: t.id,
        task: t.task,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee_username || null,
        overdueDays: daysOverdue(t.due_date),
        dueDate: toIso(t.due_date),
      }));
    const projectUserIds = [
      ...new Set(tasks.rows.map((t) => t.assigned_to).filter(Boolean)),
    ];
    context.attendance = {
      live: await getLiveAttendanceSnapshot({
        workspaceId,
        userIds: projectUserIds,
        nameLimit: 30,
        includeDetailedUsers,
      }),
      todaySignIns: await getTodaySignInsSnapshot({
        workspaceId,
        userIds: projectUserIds,
        nameLimit: 60,
      }),
      history30d: await getAttendanceHistorySnapshot({
        workspaceId,
        userIds: projectUserIds,
      }),
    };

    return context;
  }

  // ==========================
  // WORKSPACE CONTEXT
  // ==========================
  if (scope === "workspace") {
    const enterprise = await getCanonicalWorkspaceIntelligenceContext({ workspaceId });

    context.enterpriseIntelligence = enterprise;
    context.scoreHistory = enterprise.scoreHistory;
    context.trend = enterprise.trend;
    context.forecast = enterprise.forecast;
    context.workspaceRisk = enterprise.workspace?.risk || null;
    context.executiveSummaries = enterprise.executiveSummaries;

    const [workspaceTasksRes, membersRes, recentActivityRes] = await Promise.all([
      pool.query(
        `
        SELECT
          t.id,
          t.task,
          t.status,
          t.priority,
          t.due_date,
          t.project_id,
          p.name AS project_name,
          CASE WHEN LOWER(u.username) = 'autopilot' THEN NULL ELSE u.username END AS assignee_username
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.workspace_id = $1
        `,
        [workspaceId]
      ),
      pool.query(
        `SELECT u.id, u.username, u.email, u.role, u.created_at AS joined_at,
           COUNT(t.id)::int AS total_tasks,
           COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
           COUNT(t.id) FILTER (WHERE t.status = 'in-progress')::int AS in_progress_tasks,
           COUNT(t.id) FILTER (WHERE t.status = 'pending')::int AS pending_tasks,
           COUNT(t.id) FILTER (
             WHERE t.status NOT IN ('completed','cancelled')
               AND t.due_date IS NOT NULL AND t.due_date < NOW()
           )::int AS overdue_tasks
         FROM users u
         LEFT JOIN tasks t ON t.assigned_to = u.id AND t.workspace_id = $1
         WHERE u.workspace_id = $1
           AND LOWER(u.username) != 'autopilot'
         GROUP BY u.id, u.username, u.email, u.role, u.created_at
         ORDER BY u.created_at ASC`,
        [workspaceId]
      ),
      pool.query(
        `SELECT t.task, t.status, t.priority, t.updated_at,
           CASE WHEN LOWER(u.username) = 'autopilot' THEN NULL ELSE u.username END AS assignee,
           p.name AS project
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assigned_to
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.workspace_id = $1
         ORDER BY t.updated_at DESC LIMIT 25`,
        [workspaceId]
      ),
    ]);
    const workspaceTasks = workspaceTasksRes.rows || [];
    context.workspaceSummary = summarizeTaskRows(workspaceTasks);
    context.topOverdueTasks = workspaceTasks
      .filter((t) => t.due_date && t.status !== "completed" && daysOverdue(t.due_date) > 0)
      .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
      .slice(0, 12)
      .map((t) => ({
        taskId: t.id,
        task: t.task,
        projectId: t.project_id,
        projectName: t.project_name || null,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee_username || null,
        overdueDays: daysOverdue(t.due_date),
        dueDate: toIso(t.due_date),
      }));
    context.projectHealth = enterprise.projects;
    context.members = (membersRes.rows || []).map((m) => ({
      username: m.username,
      role: m.role,
      joinedAt: toIso(m.joined_at),
      tasks: {
        total: m.total_tasks,
        completed: m.completed_tasks,
        inProgress: m.in_progress_tasks,
        pending: m.pending_tasks,
        overdue: m.overdue_tasks,
      },
    }));
    context.recentActivity = (recentActivityRes.rows || []).map((r) => ({
      task: r.task,
      status: r.status,
      priority: r.priority,
      assignee: r.assignee,
      project: r.project,
      updatedAt: toIso(r.updated_at),
    }));
    context.attendance = {
      live: await getLiveAttendanceSnapshot({
        workspaceId,
        userIds: null,
        nameLimit: 60,
        includeDetailedUsers: true,
      }),
      todaySignIns: await getTodaySignInsSnapshot({
        workspaceId,
        userIds: null,
        nameLimit: 120,
      }),
      history30d: await getAttendanceHistorySnapshot({
        workspaceId,
        userIds: null,
      }),
    };

    return context;
  }

  return context;
}
