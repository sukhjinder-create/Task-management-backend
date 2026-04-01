import pool from "../db.js";
import intelligenceService from "./intelligence.service.js";
import { runManualMonthlyScoring } from "./manualScoring.service.js";
import { advancedForecast } from "./forecast/forecast.engine.js";
import { generateExecutiveSummary } from "./executiveSummary.generator.js";
import { saveExecutiveSummary } from "../events/executive/executiveSummary.store.js";
import { emitWorkspaceIntelligenceUpdate } from "../realtime/socket.js";
import { getExecutionSnapshot } from "./executionSnapshot.service.js";
import { detectSignals } from "./signal.detector.js";
import {
  getProfitabilityOracle,
  getResignationRadar,
  getGhostWorkDetection,
  getOrgTruthMap,
} from "./enterpriseIntelligence.service.js";

/**
 * USER — Monthly performance
 */
export async function getUserPerformance(req, res) {
  try {
    const { workspaceId } = req;
    const userId = req.user.id;
    const { month } = req.query;

    const data = await intelligenceService.getUserPerformance({
      workspaceId,
      userId,
      month,
    });

    return res.json(data);
  } catch (err) {
    console.error("getUserPerformance error:", err);
    res.status(500).json({ error: "Failed to fetch user performance" });
  }
}

/**
 * ADMIN — Organization insights
 * ✅ AUTHORITATIVE aggregation (no stub)
 */
export async function getAdminInsights(req, res) {
  try {
    const role = req.user.role;
    const userId = req.user.id;
    const { workspaceId } = req;
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: "month is required (YYYY-MM)" });
    }
    let projectFilter = "";
    let projectParams = [];

    // 🔥 unified execution reality + goal portfolio health (parallel)
const [executionSnapshot, goalsHealth] = await Promise.all([
  getExecutionSnapshot(workspaceId),
  computeGoalWorkspaceHealth(workspaceId),
]);

// ROLE-BASED DATA SCOPE

if (role !== "admin") {
  const { rows: projects } = await pool.query(
    `
    SELECT DISTINCT project_id
    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = $2
    `,
    [workspaceId, userId]
  );

  const projectIds = projects.map(p => p.project_id);

  if (!projectIds.length) {
    return res.json({
      orgScore: null,
      leaderboard: [],
      forecast: null,
      riskDistribution: null
    });
  }

  projectFilter = ` AND project_id = ANY($3) `;
  projectParams = [projectIds];
}
   const statsParams = [workspaceId, month, ...projectParams];

const { rows } = await pool.query(
`
SELECT
  COUNT(*) AS user_count,
  AVG(score)::numeric(5,2) AS average_score,
  COUNT(*) FILTER (WHERE score >= 80) AS high_performers,
  COUNT(*) FILTER (WHERE score < 50) AS at_risk_users,
  COUNT(*) FILTER (WHERE score >= 80) AS low_risk,
  COUNT(*) FILTER (WHERE score BETWEEN 50 AND 79) AS medium_risk,
  COUNT(*) FILTER (WHERE score < 50) AS high_risk
FROM workspace_monthly_scores
WHERE workspace_id = $1
  AND month = $2
  ${projectFilter}
`,
statsParams
);

    const stats = rows[0];
    // 🔥 Fetch last 6 months org scores for forecasting
    const historyParams =
  role === "admin"
    ? [workspaceId]
    : [workspaceId, projectParams[0]];

const historyQuery =
  role === "admin"
    ? `
      SELECT month, AVG(score) AS avg_score
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
      GROUP BY month
      ORDER BY month ASC
      LIMIT 6
    `
    : `
      SELECT month, AVG(score) AS avg_score
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND project_id = ANY($2)
      GROUP BY month
      ORDER BY month ASC
      LIMIT 6
    `;

const history = await pool.query(historyQuery, historyParams);

const scoreHistory = history.rows.map(r => Number(r.avg_score) || 0);

const forecast =
  advancedForecast(scoreHistory, executionSnapshot);

// use deterministic reasoning from engine
let forecastReasoning = forecast.reasoning || null;

    // 🔥 Leaderboard (Top performers)

    const leaderboardParams = [workspaceId, month, ...projectParams];

const leaderboardResult = await pool.query(
`
SELECT
  u.id AS userId,
  u.username,
  wms.score
FROM workspace_monthly_scores wms
JOIN users u ON u.id = wms.user_id
WHERE wms.workspace_id = $1
  AND wms.month = $2
  AND (u.is_system IS NULL OR u.is_system = false)
  AND u.role != 'system'
  ${projectFilter}
ORDER BY wms.score DESC
LIMIT 5
`,
leaderboardParams
);

  // -----------------------------
// REAL EXECUTION INTELLIGENCE
// -----------------------------
const completionRate =
  executionSnapshot.completionRate * 100;

let executionPressure = "Stable";
let executionRisk = "Low";

if (completionRate < 40) {
  executionPressure = "High";
  executionRisk = "High";
}
else if (completionRate < 65) {
  executionPressure = "Moderate";
  executionRisk = "Medium";
}

// ── Org-level signals (execution + goals portfolio) ──────────────────────
const orgSignals = detectSignals(
  { executionDiscipline: completionRate },
  scoreHistory,
  executionSnapshot,
  goalsHealth
);

    return res.json({
  orgScore: {
    averageScore: stats.average_score
      ? Number(stats.average_score)
      : null,
    userCount: Number(stats.user_count),
    highPerformers: Number(stats.high_performers),
    atRiskUsers: Number(stats.at_risk_users),
  },

  coachingEffectiveness: {},

  riskDistribution: {
    lowRisk: Number(stats.low_risk),
    mediumRisk: Number(stats.medium_risk),
    highRisk: Number(stats.high_risk),
  },

  forecast: {
    ...forecast,
    reasoning: forecastReasoning
  },

  leaderboard: leaderboardResult.rows,

  // ⭐ REAL CONTROL CENTER DATA
  execution: {
    completionRate: Math.round(completionRate),
    backlog:
      executionSnapshot.totalWork -
      executionSnapshot.completedWork,
    pressure: executionPressure,
    risk: executionRisk
  },

  signals: orgSignals,
});
} catch (err) {
  console.error("getAdminInsights error:", err);
  res.status(500).json({ error: "Failed to fetch admin insights" });
}
}

// ─── GOAL WORKSPACE HEALTH (used by intelligence layer & executive summary) ────
export async function getGoalWorkspaceHealth(req, res) {
  try {
    const { workspaceId } = req;
    const goalsHealth = await computeGoalWorkspaceHealth(workspaceId);
    return res.json(goalsHealth);
  } catch (err) {
    console.error("getGoalWorkspaceHealth error:", err);
    res.status(500).json({ error: "Failed to fetch goals health" });
  }
}

/*
  Internal helper — computes OKR portfolio health for a workspace.
  Mirrors the logic in GET /objectives/workspace/health so the intelligence
  layer can call it directly without an HTTP round-trip.
*/
/*
  Internal helper — computes goal portfolio health for a workspace.
  Mirrors the logic in GET /goals/workspace/health so the intelligence
  layer can call it directly without an HTTP round-trip.
*/
async function computeGoalWorkspaceHealth(workspaceId) {
  const { rows: objectives } = await pool.query(
    `SELECT id, title, status, progress, time_period, created_at
     FROM okr_objectives WHERE workspace_id = $1`,
    [workspaceId]
  );

  if (objectives.length === 0) {
    return {
      totalGoals: 0, byStatus: {}, atRiskCount: 0,
      stalledCount: 0, avgProgress: 0, avgHealthScore: null,
      behindCount: 0, completedCount: 0
    };
  }

  const now = new Date();

  const summaries = objectives.map(obj => {
    const tp = (obj.time_period || "").toUpperCase();
    const yearStr = tp.match(/(\d{4})/);
    const year = yearStr ? parseInt(yearStr[1]) : now.getFullYear();
    let startDate, endDate;

    if      (tp.includes("Q1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 2, 31); }
    else if (tp.includes("Q2")) { startDate = new Date(year, 3, 1);  endDate = new Date(year, 5, 30); }
    else if (tp.includes("Q3")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 8, 30); }
    else if (tp.includes("Q4")) { startDate = new Date(year, 9, 1);  endDate = new Date(year, 11, 31); }
    else if (tp.includes("H1")) { startDate = new Date(year, 0, 1);  endDate = new Date(year, 5, 30); }
    else if (tp.includes("H2")) { startDate = new Date(year, 6, 1);  endDate = new Date(year, 11, 31); }
    else                         { startDate = new Date(year, 0, 1);  endDate = new Date(year, 11, 31); }

    const totalDays       = Math.max(1, (endDate - startDate) / 86400000);
    const daysElapsed     = Math.max(0, Math.min(totalDays, (now - startDate) / 86400000));
    const expectedProgress = Math.min(100, (daysElapsed / totalDays) * 100);
    const actualProgress   = Number(obj.progress) || 0;
    const progressGap      = actualProgress - expectedProgress;

    let healthScore = 50;
    if      (progressGap >= 15)  healthScore += 25;
    else if (progressGap >= 5)   healthScore += 15;
    else if (progressGap >= -10) healthScore += 0;
    else if (progressGap >= -20) healthScore -= 15;
    else                         healthScore -= 30;
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    return {
      status:        obj.status,
      actualProgress,
      expectedProgress,
      progressGap,
      healthScore,
      isStalled:  actualProgress === 0 && daysElapsed > 14,
      isBehind:   progressGap < -10,
      isComplete: actualProgress >= 100,
    };
  });

  const byStatus = {};
  for (const s of summaries) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; }

  return {
    totalGoals: objectives.length,
    byStatus,
    atRiskCount:    summaries.filter(s => s.status === "at_risk" || s.status === "off_track").length,
    stalledCount:   summaries.filter(s => s.isStalled).length,
    behindCount:    summaries.filter(s => s.isBehind).length,
    completedCount: summaries.filter(s => s.isComplete).length,
    avgProgress:    Math.round(summaries.reduce((a, s) => a + s.actualProgress, 0) / summaries.length),
    avgHealthScore: Math.round(summaries.reduce((a, s) => a + s.healthScore, 0) / summaries.length),
  };
}

/**
 * ADMIN — Executive summary
 */
export async function getExecutiveSummary(req, res) {
  try {
    const workspaceId = req.workspaceId;
    const month = req.query.month;

    if (!month) {
      return res.status(400).json({ error: "month is required (YYYY-MM)" });
    }

    // ===== Collect structured data =====
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) AS user_count,
        AVG(score) AS avg_score,
        COUNT(*) FILTER (WHERE score >= 75) AS high_performers,
        COUNT(*) FILTER (WHERE score <= 40) AS at_risk
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND month = $2
    `, [workspaceId, month]);

    const risk = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE score > 70) AS low_risk,
        COUNT(*) FILTER (WHERE score BETWEEN 41 AND 70) AS medium_risk,
        COUNT(*) FILTER (WHERE score <= 40) AS high_risk
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND month = $2
    `, [workspaceId, month]);

    const leaderboard = await pool.query(`
      SELECT user_id, score
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND month = $2
      ORDER BY score DESC
      LIMIT 5
    `, [workspaceId, month]);

    // ===== Forecast calculation =====
const history = await pool.query(`
  SELECT month, AVG(score) AS avg_score
  FROM workspace_monthly_scores
  WHERE workspace_id = $1
  GROUP BY month
  ORDER BY month ASC
  LIMIT 6
`, [workspaceId]);

const scoreHistory = history.rows.map(r => Number(r.avg_score) || 0);

    const stats = rows[0];

  // unified execution reality + goal portfolio health (run in parallel)
  const [executionSnapshot, goalsHealth] = await Promise.all([
    getExecutionSnapshot(workspaceId),
    computeGoalWorkspaceHealth(workspaceId),
  ]);

    const data = {
  month,

  execution: executionSnapshot,

  executionContext: {
    completionRate: Math.round(executionSnapshot.completionRate * 100),
    backlog: executionSnapshot.totalWork - executionSnapshot.completedWork,
  },

  orgScore: {
    averageScore: Number(stats.avg_score) || 0,
    userCount: Number(stats.user_count) || 0,
    highPerformers: Number(stats.high_performers) || 0,
    atRiskUsers: Number(stats.at_risk) || 0,
  },

  riskDistribution: {
    low_risk: Number(risk.rows[0].low_risk) || 0,
    medium_risk: Number(risk.rows[0].medium_risk) || 0,
    high_risk: Number(risk.rows[0].high_risk) || 0,
  },

  leaderboard: leaderboard.rows,

  forecast: advancedForecast(scoreHistory, executionSnapshot),

  // Goal portfolio context — injected into the LLM prompt
  okrHealth: goalsHealth,
};

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

  // ✅ Already generated
  if (
  row.summary &&
  row.summary !== "GENERATING" &&
  row.summary.length > 20
) {
    return res.json({
      month,
      status: "ready",
      text: row.summary,
      reasoning: row.source_data?.reasoning || null
    });
  }

  // ✅ Generation already running
  if (row.source_data?.processing === true) {
    return res.json({
      month,
      status: "processing",
      text: null
    });
  }

  console.log("Starting AI generation (lock acquired)");

  // 🔒 mark processing true
  await pool.query(`
    UPDATE workspace_executive_summaries
    SET source_data = jsonb_set(source_data, '{processing}', 'true')
    WHERE workspace_id = $1 AND period = $2
  `, [workspaceId, month]);

  res.json({
    month,
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
  '{"processing": true}'::jsonb
)
ON CONFLICT (workspace_id, period) DO NOTHING
`, [workspaceId, month]);

    // ===== Respond immediately =====
    res.json({
      month,
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

    const { workspaceId } = req;
    const { month } = req.query;

    const data = await intelligenceService.getCoachingEffectiveness({
      workspaceId,
      month,
    });

    return res.json(data);
  } catch (err) {
    console.error("getCoachingEffectiveness error:", err);
    res.status(500).json({ error: "Failed to fetch coaching effectiveness" });
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

    const result = await runManualMonthlyScoring({
      workspaceId,
      month,
      triggeredBy: req.user.id,
    });

    emitWorkspaceIntelligenceUpdate(workspaceId, {
  type: "monthly-scoring-updated",
  month,
});

    return res.json({
      message: "Monthly scoring executed",
      result,
    });
  } catch (err) {
    console.error("Manual scoring error:", err);
    res.status(500).json({ error: "Failed to run monthly scoring" });
  }
}

export async function getUserTrend(req, res) {
  try {
    const workspaceId = req.workspaceId;
    const userId = req.user.id;

    const { rows } = await pool.query(`
      SELECT month, score
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND user_id = $2
      ORDER BY month ASC
      LIMIT 6
    `, [workspaceId, userId]);

    const scores = rows.map(r => r.score);

    const forecast = advancedForecast(scores);

    res.json({
      history: rows,
      forecast
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get trend" });
  }
}

export async function getUserProjectPerformance(req, res) {
  try {
    const workspaceId = req.workspaceId;
    const userId = req.user.id;
    const month = new Date().toISOString().slice(0, 7);
    const { rows } = await pool.query(`
      SELECT
  w.project_id,
  p.name AS project_name,
  w.score
FROM workspace_project_monthly_scores w
JOIN projects p ON p.id = w.project_id
WHERE w.workspace_id = $1
  AND w.user_id = $2
  AND w.month = $3
ORDER BY w.score DESC
    `, [workspaceId, userId, month]);

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get project performance" });
  }
}

/**
 * ADMIN — Per-project health scores
 */
export async function getProjectsHealth(req, res) {
  try {
    const { workspaceId } = req;

    const { rows } = await pool.query(`
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        COUNT(t.id) AS total_tasks,
        COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed_tasks,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled') AND t.due_date < NOW()) AS overdue_tasks,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')) AS active_tasks,
        ROUND(
          100.0 * COUNT(t.id) FILTER (WHERE t.status = 'completed') /
          NULLIF(COUNT(t.id), 0)
        ) AS completion_rate
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id AND t.workspace_id = $1
      WHERE p.workspace_id = $1
      GROUP BY p.id, p.name
      ORDER BY completion_rate DESC NULLS LAST
    `, [workspaceId]);

    const projects = rows.map(r => {
      const completionRate = Number(r.completion_rate) || 0;
      const overdueTasks = Number(r.overdue_tasks) || 0;
      const totalTasks = Number(r.total_tasks) || 0;
      const overdueRatio = totalTasks > 0 ? overdueTasks / totalTasks : 0;

      // Health score: start at 100, penalise overdue and low completion
      const healthScore = Math.max(0, Math.round(
        completionRate * 0.6 +
        (1 - overdueRatio) * 100 * 0.4
      ));

      const status =
        healthScore >= 75 ? 'healthy' :
        healthScore >= 50 ? 'at_risk' : 'critical';

      return {
        projectId: r.project_id,
        projectName: r.project_name,
        totalTasks,
        completedTasks: Number(r.completed_tasks) || 0,
        activeTasks: Number(r.active_tasks) || 0,
        overdueTasks,
        completionRate,
        healthScore,
        status,
      };
    });

    return res.json({ projects });
  } catch (err) {
    console.error('getProjectsHealth error:', err);
    res.status(500).json({ error: 'Failed to fetch projects health' });
  }
}

/**
 * ADMIN — Team performance comparison
 */
export async function getTeamComparison(req, res) {
  try {
    const { workspaceId } = req;
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month is required (YYYY-MM)' });
    }

    const { rows } = await pool.query(`
      SELECT
        u.id AS user_id,
        u.username,
        u.avatar_url,
        COALESCE(wms.score, 0) AS score,
        COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed_tasks,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled') AND t.due_date < NOW()) AS overdue_tasks,
        COUNT(t.id) AS total_tasks
      FROM users u
      LEFT JOIN workspace_monthly_scores wms
        ON wms.user_id = u.id AND wms.workspace_id = $1 AND wms.month = $2
      LEFT JOIN tasks t
        ON t.assigned_to = u.id AND t.workspace_id = $1
      WHERE u.workspace_id = $1
        AND u.role IN ('user', 'manager', 'admin')
        AND (u.is_system IS NULL OR u.is_system = false)
      GROUP BY u.id, u.username, u.avatar_url, wms.score
      ORDER BY score DESC
    `, [workspaceId, month]);

    const team = rows.map(r => {
      const score = Number(r.score) || 0;
      const riskLevel =
        score >= 80 ? 'low' :
        score >= 50 ? 'medium' : 'high';
      return {
        userId: r.user_id,
        username: r.username,
        avatarUrl: r.avatar_url || null,
        score,
        completedTasks: Number(r.completed_tasks) || 0,
        overdueTasks: Number(r.overdue_tasks) || 0,
        totalTasks: Number(r.total_tasks) || 0,
        riskLevel,
      };
    });

    return res.json({ month, team });
  } catch (err) {
    console.error('getTeamComparison error:', err);
    res.status(500).json({ error: 'Failed to fetch team comparison' });
  }
}

/**
 * ADMIN/ALL — Proactive workspace dashboard
 * Returns aggregated real-time health without requiring a question
 */
export async function getWorkspaceDashboard(req, res) {
  try {
    const { workspaceId } = req;
    const month = new Date().toISOString().slice(0, 7);

    const [tasksRes, autopilotRes, healthRes, scoresRes] = await Promise.all([
      // Task stats
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'in-progress') AS in_progress,
          COUNT(*) FILTER (WHERE status = 'pending') AS pending,
          COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < NOW()) AS overdue
        FROM tasks WHERE workspace_id = $1
      `, [workspaceId]),

      // Autopilot pending actions
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') AS pending_actions,
          COUNT(*) FILTER (WHERE action_type = 'handle_overdue') AS overdue_actions,
          COUNT(*) FILTER (WHERE action_type = 'escalate') AS escalated_actions
        FROM autopilot_actions WHERE workspace_id = $1
      `, [workspaceId]),

      // Workspace health score
      pool.query(`
        SELECT health_score FROM workspace_health WHERE workspace_id = $1 LIMIT 1
      `, [workspaceId]),

      // Monthly score summary
      pool.query(`
        SELECT
          ROUND(AVG(score)::numeric, 1) AS avg_score,
          COUNT(*) FILTER (WHERE score >= 80) AS high_performers,
          COUNT(*) FILTER (WHERE score < 50) AS at_risk
        FROM workspace_monthly_scores
        WHERE workspace_id = $1 AND month = $2
      `, [workspaceId, month]),
    ]);

    const tasks = tasksRes.rows[0] || {};
    const autopilot = autopilotRes.rows[0] || {};
    const scores = scoresRes.rows[0] || {};

    const completionRate = Number(tasks.total) > 0
      ? Math.round(100 * Number(tasks.completed) / Number(tasks.total))
      : 0;

    // Compute health score from real task data when no workspace_health record exists
    let healthScore = healthRes.rows[0]?.health_score != null
      ? Number(healthRes.rows[0].health_score)
      : null;
    if (healthScore === null) {
      const total = Number(tasks.total) || 0;
      if (total > 0) {
        const overdueRatio = Number(tasks.overdue) / total;
        healthScore = Math.max(0, Math.round(completionRate * 0.6 + (1 - overdueRatio) * 40));
      }
    }

    return res.json({
      month,
      healthScore,
      tasks: {
        total: Number(tasks.total) || 0,
        completed: Number(tasks.completed) || 0,
        inProgress: Number(tasks.in_progress) || 0,
        pending: Number(tasks.pending) || 0,
        overdue: Number(tasks.overdue) || 0,
        completionRate,
      },
      performance: {
        avgScore: Number(scores.avg_score) || null,
        highPerformers: Number(scores.high_performers) || 0,
        atRisk: Number(scores.at_risk) || 0,
      },
      autopilot: {
        pendingActions: Number(autopilot.pending_actions) || 0,
        overdueActions: Number(autopilot.overdue_actions) || 0,
        escalatedActions: Number(autopilot.escalated_actions) || 0,
      },
    });
  } catch (err) {
    console.error('getWorkspaceDashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch workspace dashboard' });
  }
}

/**
 * WORKSPACE — Health Pulse
 * Returns current workspace health score
 */
export async function getWorkspaceHealth(req, res) {
  try {
    const workspaceId = req.workspaceId;

    const { rows } = await pool.query(
      `
      SELECT health_score
      FROM workspace_health
      WHERE workspace_id = $1
      LIMIT 1
      `,
      [workspaceId]
    );

    if (rows.length > 0) {
      return res.json({ healthScore: Number(rows[0].health_score) });
    }

    // No health record yet — compute from real task data
    const { rows: taskRows } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND due_date < NOW()) AS overdue
      FROM tasks WHERE workspace_id = $1
    `, [workspaceId]);

    const total = Number(taskRows[0]?.total || 0);
    if (total === 0) {
      return res.json({ healthScore: null });
    }
    const completionRate = Math.round(100 * Number(taskRows[0].completed) / total);
    const overdueRatio = Number(taskRows[0].overdue) / total;
    const computed = Math.max(0, Math.round(completionRate * 0.6 + (1 - overdueRatio) * 40));
    return res.json({ healthScore: computed });

  } catch (err) {
    console.error("getWorkspaceHealth error:", err);
    res.status(500).json({
      error: "Failed to fetch workspace health"
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
    res.json(data);
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
    res.json(data);
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
    res.json(data);
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
    res.json(data);
  } catch (err) {
    console.error("getOrgTruthMap error:", err);
    res.status(500).json({ error: "Failed to compute org truth map" });
  }
}

