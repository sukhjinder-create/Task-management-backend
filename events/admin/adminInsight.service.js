import pool from "../../db.js";
import { saveAdminInsight } from "./adminInsight.store.js";
import { ADMIN_INSIGHT_TYPES } from "./adminInsight.types.js";

/**
 * Generates all admin dashboard insights for a workspace
 */
export async function generateAdminInsights({
  workspaceId,
  month,
}) {
  await generateOrgScoreOverview(workspaceId, month);
  await generateCoachingEffectiveness(workspaceId, month);
  await generateRiskDistribution(workspaceId, month);
  await generateTopImprovements(workspaceId, month);
}

// ---------------- INSIGHT BUILDERS ----------------

async function generateOrgScoreOverview(workspaceId, month) {
  const { rows } = await pool.query(
    `
    SELECT score
    FROM workspace_monthly_scores
    WHERE workspace_id = $1 AND month = $2
    `,
    [workspaceId, month]
  );

  if (!rows.length) return;

  const scores = rows.map(r => r.score);
  const avg =
    Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  await saveAdminInsight({
    workspaceId,
    period: month,
    insightType: ADMIN_INSIGHT_TYPES.ORG_SCORE_OVERVIEW,
    data: {
      averageScore: avg,
      userCount: scores.length,
      highPerformers: scores.filter(s => s >= 80).length,
      atRiskUsers: scores.filter(s => s < 50).length,
    },
  });
}

async function generateCoachingEffectiveness(workspaceId, month) {
  const { rows } = await pool.query(
    `
    SELECT outcome, COUNT(*) as count
    FROM workspace_coaching_effectiveness
    WHERE workspace_id = $1
    GROUP BY outcome
    `,
    [workspaceId]
  );

  const effectiveness = rows.reduce((acc, r) => {
    acc[r.outcome] = Number(r.count);
    return acc;
  }, {});

  await saveAdminInsight({
    workspaceId,
    period: month,
    insightType: ADMIN_INSIGHT_TYPES.COACHING_EFFECTIVENESS,
    data: effectiveness,
  });
}

async function generateRiskDistribution(workspaceId, month) {
  const { rows } = await pool.query(
    `
    SELECT score
    FROM workspace_monthly_scores
    WHERE workspace_id = $1 AND month = $2
    `,
    [workspaceId, month]
  );

  const risk = {
    lowRisk: rows.filter(r => r.score >= 80).length,
    mediumRisk: rows.filter(r => r.score >= 50 && r.score < 80).length,
    highRisk: rows.filter(r => r.score < 50).length,
  };

  await saveAdminInsight({
    workspaceId,
    period: month,
    insightType: ADMIN_INSIGHT_TYPES.RISK_DISTRIBUTION,
    data: risk,
  });
}

async function generateTopImprovements(workspaceId, month) {
  const { rows } = await pool.query(
    `
    SELECT score_after - score_before AS delta
    FROM workspace_coaching_effectiveness
    WHERE workspace_id = $1
      AND score_after IS NOT NULL
      AND score_before IS NOT NULL
    `,
    [workspaceId]
  );

  if (!rows.length) return;

  const improvements = rows
    .map(r => r.delta)
    .filter(d => d > 0);

  await saveAdminInsight({
    workspaceId,
    period: month,
    insightType: ADMIN_INSIGHT_TYPES.TOP_IMPROVEMENTS,
    data: {
      improvedUsers: improvements.length,
      avgScoreIncrease:
        Math.round(
          improvements.reduce((a, b) => a + b, 0) /
            improvements.length
        ) || 0,
    },
  });
}
