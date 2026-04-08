import pool from "../../db.js";
import { saveMonthlyScore } from "./monthlyScore.store.js";
import { buildMonthlyEvidence } from "./evidenceBuilder.service.js";
import { buildUserEvidence } from "./evidenceBuilder.js";
import { calculateScore } from "./scoreCalculator.js";

/**
 * Generates monthly score + evidence for ONE user.
 * Deterministic, auditable, and aligned with the authoritative manual scorer.
 */
export async function generateMonthlyScore({
  workspaceId,
  userId,
  month, // YYYY-MM
}) {
  const { metrics, evidence } = await buildUserEvidence({
    workspaceId,
    userId,
    month,
  });

  if (metrics.isInactive) {
    await pool.query(
      `
      DELETE FROM workspace_monthly_scores
      WHERE workspace_id = $1
        AND user_id = $2
        AND month = $3
      `,
      [workspaceId, userId, month]
    );
    return;
  }

  const scoreResult = calculateScore(metrics);
  let score = scoreResult.score;
  const breakdown = { ...scoreResult.breakdown };

  // Mandatory self-review compliance penalty.
  const { rows: missedReviews } = await pool.query(
    `SELECT COUNT(*) AS missed_count
     FROM performance_reviews pr
     JOIN review_cycles rc ON rc.id = pr.cycle_id
     WHERE pr.reviewee_id = $1
       AND pr.type = 'self'
       AND pr.status = 'missed'
       AND rc.workspace_id = $2
       AND to_char(rc.end_date, 'YYYY-MM') = $3`,
    [userId, workspaceId, month]
  );

  const missedCount = Number(missedReviews[0]?.missed_count ?? 0);
  if (missedCount > 0) {
    const penalty = missedCount * 15;
    score = Math.max(0, score - penalty);
    breakdown.missedReviewPenalty = -penalty;
    breakdown.missedReviewCount = missedCount;
  }

  const explanation = buildMonthlyEvidence({
    month,
    baselineScore: 50,
    breakdown,
    score,
  });

  const reasoning = {
    scoreComputation: {
      baseline: 50,
      attendanceScore: scoreResult.attendanceScore,
      productivityScore: scoreResult.productivityScore,
      missedReviewCount: missedCount,
      finalScore: score,
    },
    metrics,
    evidence,
    explanation,
  };

  await saveMonthlyScore({
    workspaceId,
    userId,
    month,
    score,
    breakdown,
    reasoning,
    improvements: explanation.improvementLevers,
  });
}
