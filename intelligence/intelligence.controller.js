import pool from "../db.js";
import intelligenceService from "./intelligence.service.js";
import { runManualMonthlyScoring } from "./manualScoring.service.js";

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
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { workspaceId } = req;
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: "month is required (YYYY-MM)" });
    }

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
      `,
      [workspaceId, month]
    );

    const stats = rows[0];

    return res.json({
      orgScore: {
        averageScore: stats.average_score
          ? Number(stats.average_score)
          : null,
        userCount: Number(stats.user_count),
        highPerformers: Number(stats.high_performers),
        atRiskUsers: Number(stats.at_risk_users),
      },
      coachingEffectiveness: {}, // next phase
      riskDistribution: {
        lowRisk: Number(stats.low_risk),
        mediumRisk: Number(stats.medium_risk),
        highRisk: Number(stats.high_risk),
      },
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
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { workspaceId } = req;
    const { month } = req.query;

    const summary = await intelligenceService.getExecutiveSummary({
      workspaceId,
      month,
    });

    return res.json(summary);
  } catch (err) {
    console.error("getExecutiveSummary error:", err);
    res.status(500).json({ error: "Failed to fetch executive summary" });
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

    return res.json({
      message: "Monthly scoring executed",
      result,
    });
  } catch (err) {
    console.error("Manual scoring error:", err);
    res.status(500).json({ error: "Failed to run monthly scoring" });
  }
}
