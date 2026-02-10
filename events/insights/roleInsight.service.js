import pool from "../../db.js";
import { saveRoleInsight } from "./roleInsight.store.js";

/**
 * Builds role-specific insights from monthly scores
 */
export async function generateRoleInsights({
  workspaceId,
  month,
}) {
  const { rows: scores } = await pool.query(
    `
    SELECT user_id, score, breakdown, reasoning, improvements
    FROM workspace_monthly_scores
    WHERE workspace_id = $1 AND month = $2
    `,
    [workspaceId, month]
  );

  // ---------- USER INSIGHTS ----------
  for (const row of scores) {
    await saveRoleInsight({
      workspaceId,
      role: "user",
      subjectId: row.user_id,
      month,
      insights: {
        score: row.score,
        strengths: extractStrengths(row.breakdown),
        improvements: row.improvements,
        explanation: row.reasoning,
      },
    });
  }

  // ---------- MANAGER INSIGHTS ----------
  const managerInsights = {
    topPerformers: scores
      .filter(s => s.score >= 80)
      .map(s => s.user_id),
    atRiskUsers: scores
      .filter(s => s.score < 50)
      .map(s => s.user_id),
    teamAverageScore: avg(scores.map(s => s.score)),
  };

  await saveRoleInsight({
    workspaceId,
    role: "manager",
    subjectId: null,
    month,
    insights: managerInsights,
  });

  // ---------- ADMIN INSIGHTS ----------
  const adminInsights = {
    orgAverageScore: avg(scores.map(s => s.score)),
    distribution: scoreDistribution(scores),
    participationRate: scores.length,
  };

  await saveRoleInsight({
    workspaceId,
    role: "admin",
    subjectId: null,
    month,
    insights: adminInsights,
  });
}

// ---------------- HELPERS ----------------

function avg(nums = []) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function extractStrengths(breakdown = {}) {
  const strengths = [];
  if ((breakdown.taskUpdates || 0) > 20) {
    strengths.push("Strong task ownership");
  }
  if ((breakdown.activity || 0) > 50) {
    strengths.push("High engagement");
  }
  return strengths;
}

function scoreDistribution(scores) {
  return {
    excellent: scores.filter(s => s.score >= 80).length,
    average: scores.filter(s => s.score >= 50 && s.score < 80).length,
    low: scores.filter(s => s.score < 50).length,
  };
}
