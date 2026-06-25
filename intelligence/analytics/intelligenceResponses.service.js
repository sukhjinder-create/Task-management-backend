import pool from "../../db.js";
import { getUnifiedIntelligenceSnapshot } from "../engine/unifiedIntelligence.engine.js";
import { buildTrendAnalytics, getHistoricalSeries } from "./historicalAnalytics.service.js";
import { dashboardRangeMeta } from "./dashboardChartContract.service.js";
import {
  listProjectIntelligence,
  listTeamIntelligence,
  listUserIntelligence,
} from "../repositories/unifiedIntelligence.repository.js";
import { withLegacyIsolation } from "./cutoverIsolation.service.js";
import { advancedForecast } from "../forecast/forecast.engine.js";

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function averageScore(users = []) {
  const scores = users.map((user) => Number(user.score)).filter(Number.isFinite);
  return scores.length
    ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100
    : null;
}

function summarizeUsers(users = []) {
  return {
    averageScore: averageScore(users),
    userCount: users.length,
    highPerformers: users.filter((user) => Number(user.score) >= 75).length,
    atRiskUsers: users.filter((user) => user.risk?.level === "High" || Number(user.score) < 48).length,
  };
}

function riskDistribution(users = [], style = "camel") {
  const counts = {
    low: users.filter((user) => user.risk?.level === "Low").length,
    medium: users.filter((user) => user.risk?.level === "Medium").length,
    high: users.filter((user) => user.risk?.level === "High").length,
  };
  if (style === "snake") {
    return {
      low_risk: counts.low,
      medium_risk: counts.medium,
      high_risk: counts.high,
    };
  }
  return {
    lowRisk: counts.low,
    mediumRisk: counts.medium,
    highRisk: counts.high,
  };
}

function scoreOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function buildUserScoreExplanation(user = {}) {
  const dimensions = user.dimensions || {};
  const attendance = user.attendance || {};
  const domainRows = [
    {
      key: "executionReliability",
      label: "Execution Reliability",
      score: scoreOrNull(dimensions.executionReliability?.score),
      source: "user_intelligence.dimensions.executionReliability.score",
      role: "core_execution_domain",
      note: "Commitment completion, due-date discipline, carry-over behavior, ownership, and blocker responsiveness.",
      drivers: dimensions.executionReliability?.drivers || [],
      concerns: dimensions.executionReliability?.concerns || [],
    },
    {
      key: "deliveryEffectiveness",
      label: "Delivery Effectiveness",
      score: scoreOrNull(dimensions.deliveryEffectiveness?.score),
      source: "user_intelligence.dimensions.deliveryEffectiveness.score",
      role: "core_delivery_domain",
      note: "Throughput, velocity, estimation quality, completion quality, and output consistency.",
      drivers: dimensions.deliveryEffectiveness?.drivers || [],
      concerns: dimensions.deliveryEffectiveness?.concerns || [],
    },
    {
      key: "collaborationHealth",
      label: "Collaboration Health",
      score: scoreOrNull(dimensions.collaborationHealth?.score),
      source: "user_intelligence.dimensions.collaborationHealth.score",
      role: "core_collaboration_domain",
      note: "Participation, reviews, comments, stakeholder engagement, and cross-team signals.",
      drivers: dimensions.collaborationHealth?.drivers || [],
      concerns: dimensions.collaborationHealth?.concerns || [],
    },
    {
      key: "workSustainability",
      label: "Work Sustainability",
      score: scoreOrNull(dimensions.workSustainability?.score),
      source: "user_intelligence.dimensions.workSustainability.score",
      role: "core_sustainability_domain",
      note: "Workload balance, carry-over health, focus fragmentation, overtime risk, and productivity under load.",
      drivers: dimensions.workSustainability?.drivers || [],
      concerns: dimensions.workSustainability?.concerns || [],
    },
    {
      key: "professionalDiscipline",
      label: "Professional Discipline",
      score: scoreOrNull(dimensions.professionalDiscipline?.score),
      source: "user_intelligence.dimensions.professionalDiscipline.score",
      role: "discipline_balancing_domain",
      note: "Attendance, review completion, update hygiene, and workflow compliance.",
      drivers: dimensions.professionalDiscipline?.drivers || [],
      concerns: dimensions.professionalDiscipline?.concerns || [],
    },
  ];

  const lowestDomains = [...domainRows]
    .filter((row) => row.score != null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2);
  const attendanceScore = scoreOrNull(attendance.score);
  const deliveryScore = scoreOrNull(dimensions.deliveryEffectiveness?.score);

  return {
    source: "enterprise_intelligence",
    scoreAuthority: "user_intelligence.score",
    score: scoreOrNull(user.score),
    risk: user.risk || {},
    confidence: scoreOrNull(user.confidence),
    finalScoreIsNotAverageOfEvidenceBars: true,
    summary: lowestDomains.length
      ? `Overall score is the canonical user intelligence result, not an average of the visible evidence bars. The strongest downward pressure is currently ${lowestDomains.map((row) => `${row.label} (${row.score}/100)`).join(" and ")}.`
      : "Overall score is the canonical user intelligence result, not an average of the visible evidence bars.",
    evidenceBars: [
      {
        key: "attendanceScore",
        label: "Attendance Evidence",
        score: attendanceScore,
        source: "user_intelligence.attendance.score",
        role: "feeds_professional_discipline",
        note: "Attendance contributes through Professional Discipline and attendance lift/drag rules, but it does not override execution and delivery evidence.",
      },
      {
        key: "deliveryEffectiveness",
        label: "Delivery Effectiveness",
        score: deliveryScore,
        source: "user_intelligence.dimensions.deliveryEffectiveness.score",
        role: "core_delivery_domain",
        note: "This is the delivery domain score, not the final productivity/performance score.",
      },
    ],
    domainRows,
    time: {
      computedAt: user.computedAt,
      coverageStart: user.coverageStart,
      coverageEnd: user.coverageEnd,
      attendanceClosedThroughDate: user.attendanceClosedThroughDate,
      intelligenceMode: user.intelligenceMode,
    },
  };
}

function buildForecastContract({ scoreHistory = [], workspace = null, executionContext = {}, rangeMeta = dashboardRangeMeta("30d") }) {
  const scores = (scoreHistory || [])
    .map((point) => Number(point.score))
    .filter(Number.isFinite);
  const trend = buildTrendAnalytics(scoreHistory);
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
        `Only ${scores.length} historical intelligence snapshot(s) are available for ${rangeMeta.label}. ` +
        `Outlook uses the current authoritative workspace intelligence posture until additional snapshot history is available.`,
    };
  }

  const forecast = advancedForecast(scores, {
    completionRate: Number(executionContext.completionRate || 0) / 100,
  });
  return {
    ...forecast,
    direction: trend.direction,
    delta: trend.delta,
    currentScore,
    confidenceScore: workspace?.confidence ?? null,
    range: rangeMeta,
    source: "enterprise_intelligence_snapshots",
    reasoning: forecast.reasoning || "Forecast is derived from enterprise intelligence snapshots, not recalculated from legacy score tables.",
  };
}

async function scopedAdminUsersAndProjects({ workspaceId, userId, role, snapshot }) {
  let scopedUsers = snapshot.users || [];
  let scopedProjects = snapshot.projects || [];

  if (role === "admin") {
    return { scopedUsers, scopedProjects };
  }

  const { rows: projects } = await pool.query(
    `SELECT DISTINCT project_id
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND project_id IS NOT NULL`,
    [workspaceId, userId]
  );
  const projectIds = new Set(projects.map((p) => String(p.project_id)));
  scopedProjects = scopedProjects.filter((project) => projectIds.has(String(project.projectId)));
  const { rows: members } = await pool.query(
    `SELECT DISTINCT assigned_to AS user_id
     FROM tasks
     WHERE workspace_id = $1
       AND project_id = ANY($2::uuid[])
       AND assigned_to IS NOT NULL`,
    [workspaceId, [...projectIds]]
  ).catch(() => ({ rows: [] }));
  const userIds = new Set([String(userId), ...members.map((m) => String(m.user_id))]);
  scopedUsers = scopedUsers.filter((user) => userIds.has(String(user.userId)));
  return { scopedUsers, scopedProjects };
}

export async function buildUserPerformanceResponse({ workspaceId, userId, role, month }) {
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const user = snapshot.currentUser;
  if (!user) return null;

  const dimensions = user.dimensions || {};
  return {
    source: "enterprise_intelligence",
    requestedMonth: month || monthKey(),
    effectiveMonth: monthKey(),
    scoreSource: "enterprise_intelligence",
    score: user.score,
    explanation: (user.drivers || []).slice(0, 2).join(" ") || "",
    computedAt: user.computedAt,
    coverageStart: user.coverageStart,
    coverageEnd: user.coverageEnd,
    attendanceClosedThroughDate: user.attendanceClosedThroughDate,
    breakdown: {
      attendanceScore: user.attendance?.score ?? null,
      productivityScore: dimensions.deliveryEffectiveness?.score ?? user.score,
      executionReliability: dimensions.executionReliability?.score ?? null,
      deliveryEffectiveness: dimensions.deliveryEffectiveness?.score ?? null,
      collaborationHealth: dimensions.collaborationHealth?.score ?? null,
      workSustainability: dimensions.workSustainability?.score ?? null,
      professionalDiscipline: dimensions.professionalDiscipline?.score ?? null,
      hasAttendanceTracking: user.attendance?.metrics?.expectedWorkingDays > 0,
    },
    scoreExplanation: buildUserScoreExplanation(user),
    reasoning: {
      strengths: user.strengths,
      concerns: user.concerns,
      drivers: user.drivers,
      confidence: user.confidence,
      attendance: user.attendance,
      dimensions,
    },
    coaching: [
      ...(user.concerns || []).map((concern) => ({
        message: concern,
        expectedImpact: "Improves enterprise intelligence indicators",
      })),
    ],
    intelligence: {
      dimensions: {
        executionDiscipline: dimensions.executionReliability?.score ?? 0,
        timelinessIndex: dimensions.executionReliability?.metrics?.dueDateDiscipline ?? 0,
        workloadStress: 100 - (dimensions.workSustainability?.score ?? 0),
        velocityScore: dimensions.deliveryEffectiveness?.metrics?.velocity ?? 0,
      },
      enterpriseDimensions: dimensions,
      attendance: user.attendance,
      risk: user.risk,
      signals: (user.indicators || []).map((item) => item.label || item.type).filter(Boolean),
    },
  };
}

export async function buildAdminInsightsResponse({ workspaceId, userId, role, range = "30d" }) {
  const rangeMeta = dashboardRangeMeta(range);
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const { scopedUsers, scopedProjects } = await scopedAdminUsersAndProjects({ workspaceId, userId, role, snapshot });
  const scoreHistory = await getHistoricalSeries({
    workspaceId,
    scopeType: "workspace",
    subjectKey: String(workspaceId),
    range: rangeMeta.value,
  });
  const trend = buildTrendAnalytics(scoreHistory);
  const executionContext = {
    completionRate: snapshot.workspace?.indexes?.deliveryConfidenceIndex || null,
    backlog: scopedProjects.reduce((sum, project) => sum + (project.analytics?.openTasks || 0), 0),
    pressure: snapshot.workspace?.risk?.level === "High" ? "High" : snapshot.workspace?.risk?.level === "Medium" ? "Moderate" : "Stable",
    risk: snapshot.workspace?.risk?.level || "Low",
  };

  return {
    source: "enterprise_intelligence",
    dashboardRange: rangeMeta,
    orgScore: summarizeUsers(scopedUsers),
    coachingEffectiveness: {},
    riskDistribution: riskDistribution(scopedUsers),
    forecast: buildForecastContract({ scoreHistory, workspace: snapshot.workspace, executionContext, rangeMeta }),
    leaderboard: scopedUsers.slice(0, 5).map((user) => ({
      userId: user.userId,
      username: user.username,
      score: user.score,
      risk: user.risk,
    })),
    execution: executionContext,
    signals: [
      ...(snapshot.workspace?.indicators || []),
      ...(snapshot.workspace?.concerns || []).map((concern) => ({ type: "concern", label: concern })),
    ],
    analytics: {
      workspace: snapshot.workspace,
      users: scopedUsers,
      projects: scopedProjects,
      teams: snapshot.teams,
      trend,
    },
  };
}

export async function computeGoalWorkspaceHealth(workspaceId) {
  const { rows: objectives } = await pool.query(
    `SELECT id, title, status, progress, time_period, created_at
     FROM okr_objectives WHERE workspace_id = $1`,
    [workspaceId]
  );

  if (objectives.length === 0) {
    return {
      totalGoals: 0, byStatus: {}, atRiskCount: 0,
      stalledCount: 0, avgProgress: 0, avgHealthScore: null,
      behindCount: 0, completedCount: 0,
    };
  }

  const now = new Date();
  const summaries = objectives.map((obj) => {
    const tp = (obj.time_period || "").toUpperCase();
    const yearStr = tp.match(/(\d{4})/);
    const year = yearStr ? parseInt(yearStr[1], 10) : now.getFullYear();
    let startDate;
    let endDate;

    if (tp.includes("Q1")) { startDate = new Date(year, 0, 1); endDate = new Date(year, 2, 31); }
    else if (tp.includes("Q2")) { startDate = new Date(year, 3, 1); endDate = new Date(year, 5, 30); }
    else if (tp.includes("Q3")) { startDate = new Date(year, 6, 1); endDate = new Date(year, 8, 30); }
    else if (tp.includes("Q4")) { startDate = new Date(year, 9, 1); endDate = new Date(year, 11, 31); }
    else if (tp.includes("H1")) { startDate = new Date(year, 0, 1); endDate = new Date(year, 5, 30); }
    else if (tp.includes("H2")) { startDate = new Date(year, 6, 1); endDate = new Date(year, 11, 31); }
    else { startDate = new Date(year, 0, 1); endDate = new Date(year, 11, 31); }

    const totalDays = Math.max(1, (endDate - startDate) / 86400000);
    const daysElapsed = Math.max(0, Math.min(totalDays, (now - startDate) / 86400000));
    const expectedProgress = Math.min(100, (daysElapsed / totalDays) * 100);
    const actualProgress = Number(obj.progress) || 0;
    const progressGap = actualProgress - expectedProgress;

    let healthScore = 50;
    if (progressGap >= 15) healthScore += 25;
    else if (progressGap >= 5) healthScore += 15;
    else if (progressGap >= -10) healthScore += 0;
    else if (progressGap >= -20) healthScore -= 15;
    else healthScore -= 30;
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    return {
      status: obj.status,
      actualProgress,
      expectedProgress,
      progressGap,
      healthScore,
      isStalled: actualProgress === 0 && daysElapsed > 14,
      isBehind: progressGap < -10,
      isComplete: actualProgress >= 100,
    };
  });

  const byStatus = {};
  for (const summary of summaries) byStatus[summary.status] = (byStatus[summary.status] || 0) + 1;

  return {
    totalGoals: objectives.length,
    byStatus,
    atRiskCount: summaries.filter((summary) => summary.status === "at_risk" || summary.status === "off_track").length,
    stalledCount: summaries.filter((summary) => summary.isStalled).length,
    behindCount: summaries.filter((summary) => summary.isBehind).length,
    completedCount: summaries.filter((summary) => summary.isComplete).length,
    avgProgress: Math.round(summaries.reduce((sum, summary) => sum + summary.actualProgress, 0) / summaries.length),
    avgHealthScore: Math.round(summaries.reduce((sum, summary) => sum + summary.healthScore, 0) / summaries.length),
  };
}

export async function buildExecutiveSummaryData({ workspaceId, userId, role, month, range = "30d" }) {
  const rangeMeta = dashboardRangeMeta(range);
  const [snapshot, scoreHistory, rawGoalsHealth] = await Promise.all([
    getUnifiedIntelligenceSnapshot({ workspaceId, userId, role }),
    getHistoricalSeries({
      workspaceId,
      scopeType: "workspace",
      subjectKey: String(workspaceId),
      range: rangeMeta.value,
    }),
    computeGoalWorkspaceHealth(workspaceId),
  ]);
  const goalsHealth = withLegacyIsolation(rawGoalsHealth, {
    surface: "okr_goal_health_context",
    reason: "OKR health is contextual goal-module analytics and is excluded from core enterprise executive scoring.",
    replacement: "workspace_intelligence and project_intelligence",
  });

  const users = snapshot.users || [];
  const projects = snapshot.projects || [];
  const executionContext = {
    completionRate: snapshot.workspace?.indexes?.deliveryConfidenceIndex ?? null,
    backlog: projects.reduce((sum, project) => sum + (project.analytics?.openTasks || 0), 0),
  };

  return {
    month,
    source: "enterprise_intelligence",
    dashboardRange: rangeMeta,
    execution: {
      workspaceHealthIndex: snapshot.workspace?.score ?? null,
      deliveryConfidenceIndex: snapshot.workspace?.indexes?.deliveryConfidenceIndex ?? null,
      productivityIndex: snapshot.workspace?.indexes?.productivityIndex ?? null,
      strategicRiskIndex: snapshot.workspace?.indexes?.strategicRiskIndex ?? null,
    },
    executionContext,
    orgScore: summarizeUsers(users),
    riskDistribution: riskDistribution(users, "snake"),
    leaderboard: users.slice(0, 5).map((user) => ({
      user_id: user.userId,
      username: user.username,
      score: user.score,
      confidence: user.confidence,
      risk: user.risk,
    })),
    forecast: buildForecastContract({ scoreHistory, workspace: snapshot.workspace, executionContext, rangeMeta }),
    okrHealth: null,
    legacyContext: {
      okrHealth: goalsHealth,
    },
    intelligence: {
      workspace: snapshot.workspace,
      projects,
      teams: snapshot.teams || [],
    },
  };
}

export async function buildCoachingEffectivenessResponse({ workspaceId, userId, role, month }) {
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const users = snapshot.users || [];
  const concernCounts = new Map();
  for (const user of users) {
    for (const concern of user.concerns || []) {
      concernCounts.set(concern, (concernCounts.get(concern) || 0) + 1);
    }
  }
  return {
    source: "enterprise_intelligence",
    month: month || monthKey(),
    totalUsers: users.length,
    improving: users.filter((user) => user.trend === "up").length,
    stable: users.filter((user) => user.trend === "flat").length,
    declining: users.filter((user) => user.trend === "down").length,
    highRisk: users.filter((user) => user.risk?.level === "High").length,
    lowConfidence: users.filter((user) => Number(user.confidence) < 55).length,
    topCoachingThemes: [...concernCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({ label, count })),
  };
}

export async function buildUserTrendResponse({ workspaceId, userId, role, range }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const rows = await getHistoricalSeries({
    workspaceId,
    scopeType: "user",
    subjectKey: String(userId),
    range: range || "30d",
  });
  const series = rows.map((row) => ({
    month: String(row.date).slice(0, 7),
    date: row.date,
    score: row.score,
    computedAt: row.computedAt,
    coverageStart: row.coverageStart,
    coverageEnd: row.coverageEnd,
    attendanceClosedThroughDate: row.attendanceClosedThroughDate,
    snapshotDate: row.snapshotDate,
  }));
  return {
    source: "enterprise_intelligence",
    scopeType: "user",
    subjectKey: String(userId),
    range: range || "30d",
    trend: buildTrendAnalytics(series),
    series,
    rows: series,
  };
}

export async function buildUnifiedHistoryResponse({
  workspaceId,
  userId,
  role,
  scopeType,
  subjectKey,
  range,
  startDate,
  endDate,
}) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const series = await getHistoricalSeries({
    workspaceId,
    scopeType,
    subjectKey,
    range: range || "30d",
    startDate,
    endDate,
  });
  return {
    source: "enterprise_intelligence",
    scopeType,
    subjectKey,
    range: range || "30d",
    trend: buildTrendAnalytics(series),
    series,
  };
}

export async function buildUserProjectPerformanceResponse({ workspaceId, userId, role }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const { rows: assignedProjects } = await pool.query(
    `SELECT DISTINCT project_id
     FROM tasks
     WHERE workspace_id = $1
       AND assigned_to = $2
       AND project_id IS NOT NULL`,
    [workspaceId, userId]
  );
  const projectIds = assignedProjects.map((row) => row.project_id);
  if (projectIds.length === 0) {
    return {
      source: "enterprise_intelligence",
      projects: [],
      rows: [],
    };
  }
  const projects = await listProjectIntelligence({ workspaceId, projectIds });

  const rows = projects.map((project) => ({
    project_id: project.projectId,
    project_name: project.projectName,
    score: project.score,
    band: project.band,
    risk: project.risk,
    indexes: project.indexes,
    computedAt: project.computedAt,
    coverageStart: project.coverageStart,
    coverageEnd: project.coverageEnd,
  }));
  return {
    source: "enterprise_intelligence",
    projects: rows,
    rows,
  };
}

export async function buildProjectsHealthResponse({ workspaceId, userId, role }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const intelligenceProjects = await listProjectIntelligence({ workspaceId });
  return {
    source: "enterprise_intelligence",
    projects: intelligenceProjects.map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      totalTasks: project.analytics?.totalTasks || 0,
      completedTasks: project.analytics?.completedTasks || 0,
      activeTasks: project.analytics?.openTasks || 0,
      overdueTasks: project.analytics?.overdueTasks || 0,
      completionRate: project.analytics?.completionRate || 0,
      healthScore: project.score,
      status: project.risk?.level === "High" ? "critical" : project.risk?.level === "Medium" ? "at_risk" : "healthy",
      indexes: project.indexes,
      confidence: project.confidence,
      indicators: project.indicators,
      computedAt: project.computedAt,
      coverageStart: project.coverageStart,
      coverageEnd: project.coverageEnd,
    })),
  };
}

export async function buildTeamComparisonResponse({ workspaceId, userId, role, month }) {
  await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const [users, teams] = await Promise.all([
    listUserIntelligence({ workspaceId }),
    listTeamIntelligence({ workspaceId }),
  ]);
  return {
    month,
    source: "enterprise_intelligence",
    surfaceClassification: "derived_user_comparison",
    authority: {
      scoreAuthority: "user_intelligence",
      canonicalTeamAuthority: "team_intelligence",
      teamScoreAuthority: false,
      dashboardScoreAuthority: false,
      purpose: "rank and compare user intelligence profiles in a team-style table without creating a canonical team score",
    },
    cutover: {
      status: "derived_comparison_surface",
      conflictsWithCanonicalTeamIntelligence: false,
      canonicalTeamRowsIncludedForReference: teams.length,
    },
    canonicalTeams: teams.map((team) => ({
      teamKey: team.teamKey,
      managerId: team.managerId,
      managerName: team.managerName,
      score: team.score,
      band: team.band,
      indexes: team.indexes,
      confidence: team.confidence,
      computedAt: team.computedAt,
      coverageStart: team.coverageStart,
      coverageEnd: team.coverageEnd,
      attendanceClosedThroughDate: team.attendanceClosedThroughDate,
    })),
    team: users.map((user) => ({
      userId: user.userId,
      username: user.username,
      avatarUrl: null,
      score: user.score,
      completedTasks: user.analytics?.completedWork || 0,
      overdueTasks: user.analytics?.overdueWork || 0,
      totalTasks: user.analytics?.assignedWork || 0,
      riskLevel: String(user.risk?.level || "medium").toLowerCase(),
      confidence: user.confidence,
      indicators: user.indicators,
      computedAt: user.computedAt,
      coverageStart: user.coverageStart,
      coverageEnd: user.coverageEnd,
      attendanceClosedThroughDate: user.attendanceClosedThroughDate,
    })),
  };
}

export async function buildWorkspaceDashboardResponse({ workspaceId, userId, role }) {
  const month = monthKey();
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const workspaceIntel = snapshot.workspace;
  const [tasksRes, autopilotRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed,
         COUNT(*) FILTER (WHERE status = 'in-progress') AS in_progress,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < NOW()) AS overdue
       FROM tasks WHERE workspace_id = $1`,
      [workspaceId]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_actions,
         COUNT(*) FILTER (WHERE action_type = 'handle_overdue') AS overdue_actions,
         COUNT(*) FILTER (WHERE action_type = 'escalate') AS escalated_actions
       FROM autopilot_actions WHERE workspace_id = $1`,
      [workspaceId]
    ),
  ]);

  const tasks = tasksRes.rows[0] || {};
  const autopilot = autopilotRes.rows[0] || {};
  const totalTasks = Number(tasks.total) || 0;
  const completedTasks = Number(tasks.completed) || 0;

  return {
    month,
    source: "enterprise_intelligence",
    healthScore: workspaceIntel?.score ?? null,
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      inProgress: Number(tasks.in_progress) || 0,
      pending: Number(tasks.pending) || 0,
      overdue: Number(tasks.overdue) || 0,
      completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    },
    performance: {
      avgScore: workspaceIntel?.analytics?.averageUserScore ?? null,
      highPerformers: workspaceIntel?.analytics?.highPerformers || 0,
      atRisk: workspaceIntel?.analytics?.atRiskUsers || 0,
    },
    autopilot: {
      pendingActions: Number(autopilot.pending_actions) || 0,
      overdueActions: Number(autopilot.overdue_actions) || 0,
      escalatedActions: Number(autopilot.escalated_actions) || 0,
    },
    intelligence: workspaceIntel,
    computedAt: workspaceIntel?.computedAt || null,
    coverageStart: workspaceIntel?.coverageStart || null,
    coverageEnd: workspaceIntel?.coverageEnd || null,
    attendanceClosedThroughDate: workspaceIntel?.attendanceClosedThroughDate || null,
  };
}

export async function buildWorkspaceHealthResponse({ workspaceId, userId, role }) {
  const snapshot = await getUnifiedIntelligenceSnapshot({ workspaceId, userId, role });
  const workspaceIntel = snapshot.workspace;
  return {
    source: "enterprise_intelligence",
    healthScore: workspaceIntel?.score ?? null,
    band: workspaceIntel?.band ?? null,
    trend: workspaceIntel?.trend ?? null,
    confidence: workspaceIntel?.confidence ?? null,
    strengths: workspaceIntel?.strengths || [],
    concerns: workspaceIntel?.concerns || [],
    drivers: workspaceIntel?.drivers || [],
    indexes: workspaceIntel?.indexes || {},
    risk: workspaceIntel?.risk || null,
    computedAt: workspaceIntel?.computedAt || null,
    coverageStart: workspaceIntel?.coverageStart || null,
    coverageEnd: workspaceIntel?.coverageEnd || null,
    attendanceClosedThroughDate: workspaceIntel?.attendanceClosedThroughDate || null,
  };
}

export default {
  buildUserPerformanceResponse,
  buildAdminInsightsResponse,
  computeGoalWorkspaceHealth,
  buildExecutiveSummaryData,
  buildCoachingEffectivenessResponse,
  buildUnifiedHistoryResponse,
  buildUserTrendResponse,
  buildUserProjectPerformanceResponse,
  buildProjectsHealthResponse,
  buildTeamComparisonResponse,
  buildWorkspaceDashboardResponse,
  buildWorkspaceHealthResponse,
};
