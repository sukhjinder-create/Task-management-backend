import pool from "../db.js";
import intelligenceService from "./intelligence.service.js";
import { runManualMonthlyScoring } from "./manualScoring.service.js";
import { advancedForecast } from "./forecast/forecast.engine.js";
import { generateExecutiveSummary } from "./executiveSummary.generator.js";
import { saveExecutiveSummary } from "../events/executive/executiveSummary.store.js";
import { emitWorkspaceIntelligenceUpdate } from "../realtime/socket.js";

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

const forecast = advancedForecast(scoreHistory);

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
  ${projectFilter}
ORDER BY wms.score DESC
LIMIT 5
`,
leaderboardParams
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
  leaderboard: leaderboardResult.rows
});
} catch (err) {
  console.error("getAdminInsights error:", err);
  res.status(500).json({ error: "Failed to fetch admin insights" });
}
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

const forecast = advancedForecast(scoreHistory);

    const stats = rows[0];

    const data = {
      month,
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
      forecast
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

    // If not initialized yet → neutral baseline
    if (!rows.length) {
      return res.json({
        healthScore: 70
      });
    }

    return res.json({
      healthScore: Number(rows[0].health_score)
    });

  } catch (err) {
    console.error("getWorkspaceHealth error:", err);
    res.status(500).json({
      error: "Failed to fetch workspace health"
    });
  }
}
