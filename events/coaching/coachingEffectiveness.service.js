import pool from "../../db.js";
import { v4 as uuid } from "uuid";
import { extractMetricsForNudge } from "./effectivenessMetrics.extractor.js";

/**
 * =========================================================
 * COACHING EFFECTIVENESS EVALUATION (ENTERPRISE)
 *
 * - Deterministic
 * - Idempotent
 * - Nudge-specific
 * - Evidence-based
 * - Audit-safe
 *
 * Runs AFTER next month's scoring.
 * =========================================================
 */
export async function evaluateCoachingEffectiveness({
  workspaceId,
  userId,
  previousMonth,
  currentMonth,
}) {
  /**
   * 1️⃣ Fetch nudges that were NOT already evaluated
   * (CRITICAL for re-runs & cron safety)
   */
  const { rows: nudges } = await pool.query(
    `
    SELECT id, nudge_type, evidence
    FROM workspace_coaching_nudges
    WHERE workspace_id = $1
      AND user_id = $2
      AND period = $3
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_coaching_effectiveness e
        WHERE e.nudge_id = workspace_coaching_nudges.id
      )
    `,
    [workspaceId, userId, previousMonth]
  );

  if (!nudges.length) return;

  /**
   * 2️⃣ Fetch scores BEFORE and AFTER
   */
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

  /**
   * 3️⃣ Evaluate each nudge independently
   */
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

    const outcome = classifyOutcome({
      baselineMetrics,
      followupMetrics,
      scoreDelta,
    });

    await pool.query(
      `
      INSERT INTO workspace_coaching_effectiveness (
        id,
        workspace_id,
        user_id,
        nudge_id,
        nudge_type,
        baseline_metrics,
        followup_metrics,
        score_before,
        score_after,
        score_delta,
        outcome,
        evaluated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,
        $8,$9,$10,
        $11,
        now()
      )
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

/* =========================================================
   OUTCOME CLASSIFICATION (ENTERPRISE-GRADE)
========================================================= */

function classifyOutcome({ baselineMetrics, followupMetrics, scoreDelta }) {
  const improved = hasMeaningfulImprovement(
    baselineMetrics,
    followupMetrics
  );

  /**
   * Enterprise semantics:
   * - highly_effective → strong causal improvement
   * - effective        → improvement observed
   * - ignored          → advice not acted on
   * - counterproductive→ behavior worsened
   */
  if (improved && scoreDelta >= 10) return "highly_effective";
  if (improved && scoreDelta > 0) return "effective";
  if (!improved && scoreDelta === 0) return "ignored";
  if (!improved && scoreDelta < 0) return "counterproductive";

  return "neutral";
}

/**
 * Determines if there is a real, metric-level improvement
 * (NOT JSON string comparison — enterprise safe)
 */
function hasMeaningfulImprovement(baseline = {}, followup = {}) {
  const keys = new Set([
    ...Object.keys(baseline),
    ...Object.keys(followup),
  ]);

  for (const key of keys) {
    const before = baseline[key] ?? 0;
    const after = followup[key] ?? 0;

    if (after > before) {
      return true;
    }
  }

  return false;
}
