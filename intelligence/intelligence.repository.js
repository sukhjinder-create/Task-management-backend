import pool from "../db.js";

/**
 * IntelligenceRepository
 *
 * ONLY READS
 */
class IntelligenceRepository {
  async getMonthlyUserScore({ workspaceId, userId, month }) {
    const { rows } = await pool.query(
      `
      SELECT score, breakdown, reasoning, improvements AS coaching
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND user_id = $2
        AND month = $3
      LIMIT 1
      `,
      [workspaceId, userId, month]
    );

    return rows[0] || null;
  }

  async getAdminInsights({ workspaceId, month }) {
  const orgStats = await pool.query(`
    SELECT
      COUNT(*) AS user_count,
      AVG(score) AS avg_score,
      COUNT(*) FILTER (WHERE score >= 75) AS high_performers,
      COUNT(*) FILTER (WHERE score <= 40) AS at_risk
    FROM workspace_monthly_scores
    WHERE workspace_id = $1
      AND month = $2
  `, [workspaceId, month]);

  const riskDist = await pool.query(`
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

  return {
    orgScore: {
      averageScore: Number(orgStats.rows[0].avg_score || 0),
      userCount: Number(orgStats.rows[0].user_count || 0),
      highPerformers: Number(orgStats.rows[0].high_performers || 0),
      atRiskUsers: Number(orgStats.rows[0].at_risk || 0),
    },
    riskDistribution: riskDist.rows[0],
    leaderboard: leaderboard.rows,
  };
    /* -----------------------------
       2️⃣ RISK DISTRIBUTION
    ------------------------------ */
    const { rows: risk } = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE score >= 75)::int AS low_risk,
        COUNT(*) FILTER (WHERE score BETWEEN 41 AND 74)::int AS medium_risk,
        COUNT(*) FILTER (WHERE score <= 40)::int AS high_risk
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND month = $2
      `,
      [workspaceId, month]
    );

    const riskDistribution = {
      lowRisk: risk[0]?.low_risk ?? 0,
      mediumRisk: risk[0]?.medium_risk ?? 0,
      highRisk: risk[0]?.high_risk ?? 0,
    };

    /* -----------------------------
       3️⃣ COACHING EFFECTIVENESS
    ------------------------------ */
    const { rows: coaching } = await pool.query(
      `
      SELECT
        nudge_type,
        outcome,
        COUNT(*)::int AS count
      FROM workspace_coaching_effectiveness
      WHERE workspace_id = $1
        AND date_trunc('month', evaluated_at) =
            date_trunc('month', $2::date)
      GROUP BY nudge_type, outcome
      `,
      [workspaceId, monthDate]
    );

    const coachingEffectiveness = {};
    for (const row of coaching) {
      if (!coachingEffectiveness[row.nudge_type]) {
        coachingEffectiveness[row.nudge_type] = {};
      }
      coachingEffectiveness[row.nudge_type][row.outcome] = row.count;
    }

    return {
      orgScore,
      coachingEffectiveness,
      riskDistribution,
    };
  }

  /**
   * EXECUTIVE SUMMARY (STUB — PHASE 6)
   */
  async getExecutiveSummary({ workspaceId, month }) {
    return {
      month,
      text:
        "Executive summary will be generated after the intelligence cycle completes.",
    };
  }
}
export default new IntelligenceRepository();
