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

  async getAdminInsights({ workspaceId, month }) {
    return intelligenceRepository.getAdminInsights({
      workspaceId,
      month,
    });
  }

  async getExecutiveSummary({ workspaceId, month }) {
    return intelligenceRepository.getExecutiveSummary({
      workspaceId,
      month,
    });
  }
}

export default new IntelligenceService();
