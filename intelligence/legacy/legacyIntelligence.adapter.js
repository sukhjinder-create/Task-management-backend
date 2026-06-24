import pool from "../../db.js";
import intelligenceService from "../intelligence.service.js";

function monthKey(month) {
  return month || new Date().toISOString().slice(0, 7);
}

function riskLevel(score) {
  const value = Number(score) || 0;
  if (value < 45) return "high";
  if (value < 70) return "medium";
  return "low";
}

export async function getLegacyUserPerformanceResponse({ workspaceId, userId, month }) {
  const data = await intelligenceService.getUserPerformance({
    workspaceId,
    userId,
    month,
  });
  return {
    ...data,
    source: "legacy_scoring_rollback",
  };
}

export async function getLegacyAdminInsightsResponse({ workspaceId, month }) {
  const data = await intelligenceService.getAdminInsights({
    workspaceId,
    month: monthKey(month),
  });
  return {
    source: "legacy_scoring_rollback",
    ...data,
  };
}

export async function getLegacyCoachingEffectivenessResponse({ workspaceId, month }) {
  const rows = await intelligenceService.getCoachingEffectiveness({
    workspaceId,
    month: monthKey(month),
  });
  return {
    source: "legacy_scoring_rollback",
    month: monthKey(month),
    rows,
  };
}

export async function getLegacyUserTrendResponse({ workspaceId, userId }) {
  return intelligenceService.getUserTrend({ workspaceId, userId });
}

export async function getLegacyUserProjectPerformanceResponse({ workspaceId, userId }) {
  return intelligenceService.getUserProjectPerformance({ workspaceId, userId });
}

export async function getLegacyProjectsHealthResponse({ workspaceId, month }) {
  const { rows } = await pool.query(
    `SELECT
       wpms.project_id,
       p.name AS project_name,
       ROUND(AVG(wpms.score), 2) AS score
     FROM workspace_project_monthly_scores wpms
     LEFT JOIN projects p ON p.id = wpms.project_id
     WHERE wpms.workspace_id = $1
       AND wpms.month = $2
     GROUP BY wpms.project_id, p.name
     ORDER BY score DESC NULLS LAST`,
    [workspaceId, monthKey(month)]
  ).catch(() => ({ rows: [] }));

  return {
    source: "legacy_scoring_rollback",
    projects: rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name,
      healthScore: Number(row.score) || 0,
      score: Number(row.score) || 0,
      status: riskLevel(row.score) === "high" ? "critical" : riskLevel(row.score) === "medium" ? "at_risk" : "healthy",
    })),
  };
}

export async function getLegacyTeamComparisonResponse({ workspaceId, month }) {
  const { rows } = await pool.query(
    `SELECT
       wms.user_id,
       u.username,
       wms.score,
       wms.breakdown,
       wms.reasoning
     FROM workspace_monthly_scores wms
     LEFT JOIN users u ON u.id = wms.user_id
     WHERE wms.workspace_id = $1
       AND wms.month = $2
     ORDER BY wms.score DESC, u.username ASC`,
    [workspaceId, monthKey(month)]
  ).catch(() => ({ rows: [] }));

  return {
    source: "legacy_scoring_rollback",
    surfaceClassification: "legacy_user_comparison",
    authority: {
      scoreAuthority: "workspace_monthly_scores",
      canonicalTeamAuthority: "team_intelligence",
      teamScoreAuthority: false,
    },
    month: monthKey(month),
    team: rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      score: Number(row.score) || 0,
      completedTasks: Number(row.reasoning?.metrics?.completed_tasks) || 0,
      overdueTasks: Number(row.reasoning?.metrics?.active_overdue) || 0,
      totalTasks: Number(row.reasoning?.metrics?.total_tasks) || 0,
      riskLevel: riskLevel(row.score),
      confidence: null,
      indicators: [],
    })),
  };
}

export async function getLegacyWorkspaceDashboardResponse({ workspaceId }) {
  const month = monthKey();
  const [{ rows: scoreRows }, { rows: taskRows }, { rows: healthRows }] = await Promise.all([
    pool.query(
      `SELECT ROUND(AVG(score), 2) AS score
       FROM workspace_monthly_scores
       WHERE workspace_id = $1
         AND month = $2`,
      [workspaceId, month]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE status IN ('in-progress', 'in_progress'))::int AS in_progress,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < NOW())::int AS overdue
       FROM tasks WHERE workspace_id = $1`,
      [workspaceId]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT health_score FROM workspace_health WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    ).catch(() => ({ rows: [] })),
  ]);

  const tasks = taskRows[0] || {};
  const total = Number(tasks.total) || 0;
  const completed = Number(tasks.completed) || 0;
  return {
    source: "legacy_scoring_rollback",
    month,
    healthScore: healthRows[0]?.health_score != null
      ? Number(healthRows[0].health_score)
      : Number(scoreRows[0]?.score) || null,
    tasks: {
      total,
      completed,
      inProgress: Number(tasks.in_progress) || 0,
      pending: Number(tasks.pending) || 0,
      overdue: Number(tasks.overdue) || 0,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
    },
    intelligence: null,
  };
}

export async function getLegacyWorkspaceHealthResponse({ workspaceId }) {
  const { rows } = await pool.query(
    `SELECT health_score, updated_at
     FROM workspace_health
     WHERE workspace_id = $1
     LIMIT 1`,
    [workspaceId]
  ).catch(() => ({ rows: [] }));
  const row = rows[0] || {};
  return {
    source: "legacy_scoring_rollback",
    healthScore: row.health_score == null ? null : Number(row.health_score),
    band: riskLevel(row.health_score),
    computedAt: row.updated_at || null,
    strengths: [],
    concerns: [],
    drivers: ["Legacy workspace health rollback row"],
  };
}

export default {
  getLegacyAdminInsightsResponse,
  getLegacyCoachingEffectivenessResponse,
  getLegacyProjectsHealthResponse,
  getLegacyTeamComparisonResponse,
  getLegacyUserPerformanceResponse,
  getLegacyUserProjectPerformanceResponse,
  getLegacyUserTrendResponse,
  getLegacyWorkspaceDashboardResponse,
  getLegacyWorkspaceHealthResponse,
};
