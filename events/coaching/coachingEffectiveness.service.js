import pool from "../../db.js";
import { v4 as uuid } from "uuid";
import { extractMetricsForNudge } from "./effectivenessMetrics.extractor.js";

/**
 * Evaluates effectiveness of coaching nudges
 * Runs AFTER next month's scoring
 */
export async function evaluateCoachingEffectiveness({
  workspaceId,
  userId,
  previousMonth,
  currentMonth,
}) {
  // 1️⃣ Get coaching nudges from previous month
  const { rows: nudges } = await pool.query(
    `
    SELECT id, nudge_type, evidence
    FROM workspace_coaching_nudges
    WHERE workspace_id = $1
      AND user_id = $2
      AND period = $3
    `,
    [workspaceId, userId, previousMonth]
  );

  if (!nudges.length) return;

  // 2️⃣ Get monthly scores (before & after)
  const { rows: scores } = await pool.query(
    `
    SELECT month, score, reasoning
    FROM workspace_monthly_scores
    WHERE workspace_id = $1
      AND user_id = $2
      AND month IN ($3, $4)
    `,
    [workspaceId, userId, previousMonth, currentMonth]
  );

  const before = scores.find(s => s.month === previousMonth);
  const after = scores.find(s => s.month === currentMonth);
  if (!before || !after) return;

  // 3️⃣ Evaluate each nudge independently
  for (const nudge of nudges) {
    const baselineMetrics = extractMetricsForNudge({
      nudgeType: nudge.nudge_type,
      evidence: before.reasoning?.evidence,
    });

    const followupMetrics = extractMetricsForNudge({
      nudgeType: nudge.nudge_type,
      evidence: after.reasoning?.evidence,
    });

    const scoreDelta = after.score - before.score;

    const outcome = classifyOutcome(
      baselineMetrics,
      followupMetrics,
      scoreDelta
    );

    await pool.query(
      `
      INSERT INTO workspace_coaching_effectiveness
        (id, workspace_id, user_id, nudge_id, nudge_type,
         baseline_metrics, followup_metrics,
         score_before, score_after, score_delta, outcome)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        uuid(),
        workspaceId,
        userId,
        nudge.id,
        nudge.nudge_type,
        baselineMetrics,
        followupMetrics,
        before.score,
        after.score,
        scoreDelta,
        outcome,
      ]
    );
  }
}

// ---------------- HELPERS ----------------

function classifyOutcome(baseline, followup, scoreDelta) {
  const improved =
    JSON.stringify(followup) !== JSON.stringify(baseline);

  if (improved && scoreDelta > 5) return "positive";
  if (improved && scoreDelta >= 0) return "neutral";
  if (!improved) return "none";
  return "negative";
}
