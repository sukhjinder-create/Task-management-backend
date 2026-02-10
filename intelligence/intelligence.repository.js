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
      SELECT score, reasoning, improvements AS coaching
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
    // SAFE placeholder until scoring is live
    return {
      orgScore: {
        averageScore: null,
        userCount: 0,
        highPerformers: 0,
        atRiskUsers: 0,
      },
      coachingEffectiveness: {},
      riskDistribution: {
        lowRisk: 0,
        mediumRisk: 0,
        highRisk: 0,
      },
    };
  }

  async getExecutiveSummary({ workspaceId, month }) {
    // SAFE placeholder until generation is live
    return {
      month,
      text:
        "Executive summary is not available yet. It will be generated after the monthly intelligence cycle completes.",
    };
  }
}

export default new IntelligenceRepository();
