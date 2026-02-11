import pool from "../../db.js";
import { evaluateCoachingEffectiveness } from "./coachingEffectiveness.service.js";

export async function runMonthlyCoachingEvaluation({
  workspaceId,
  previousMonth,
  currentMonth,
}) {
  const { rows: nudges } = await pool.query(
    `
    SELECT
      n.id as nudge_id,
      n.user_id,
      s1.score as baseline_score,
      s2.score as followup_score,
      s1.risk_level as baseline_risk,
      s2.risk_level as followup_risk
    FROM coaching_nudges n
    JOIN workspace_monthly_scores s1
      ON s1.user_id = n.user_id
     AND s1.month = $2
    JOIN workspace_monthly_scores s2
      ON s2.user_id = n.user_id
     AND s2.month = $3
    WHERE n.workspace_id = $1
      AND n.period = $2
      AND n.evaluated_at IS NULL
    `,
    [workspaceId, previousMonth, currentMonth]
  );

  for (const n of nudges) {
    await evaluateCoachingEffectiveness({
      workspaceId,
      userId: n.user_id,
      nudgeId: n.nudge_id,
      baselineScore: n.baseline_score,
      followupScore: n.followup_score,
      baselineRisk: n.baseline_risk,
      followupRisk: n.followup_risk,
    });
  }
}
