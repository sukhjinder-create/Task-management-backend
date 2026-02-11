import pool from "../db.js";
import intelligenceRepository from "./intelligence.repository.js";

/**
 * IntelligenceService
 *
 * READ-ONLY
 * No writes
 * No cron
 * No AI calls
 */
class IntelligenceService {
  /**
   * USER — Monthly performance
   */
  async getUserPerformance({ workspaceId, userId, month }) {
    const record =
      await intelligenceRepository.getMonthlyUserScore({
        workspaceId,
        userId,
        month,
      });

    if (!record) return null;

    return {
      score: record.score,
      explanation: record.reasoning?.summary || "",
      coaching: record.coaching || [],
    };
  }

  /**
   * ADMIN — Org-level insights
   */
  async getAdminInsights({ workspaceId, month }) {
    return intelligenceRepository.getAdminInsights({
      workspaceId,
      month,
    });
  }

  /**
   * ADMIN — Executive summary
   */
  async getExecutiveSummary({ workspaceId, month }) {
    return intelligenceRepository.getExecutiveSummary({
      workspaceId,
      month,
    });
  }

  /**
   * ADMIN — Coaching effectiveness (Phase 4)
   */
  async getCoachingEffectiveness({ workspaceId, month }) {
    const { rows } = await pool.query(
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
      ORDER BY nudge_type, outcome
      `,
      [workspaceId, `${month}-01`]
    );

    return rows;
  }
}

export default new IntelligenceService();
