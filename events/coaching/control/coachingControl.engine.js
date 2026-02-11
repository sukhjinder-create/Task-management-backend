import pool from "../../../db.js";
import { COACHING_POLICY } from "./coachingPolicy.rules.js";
import { saveNudgeThrottle } from "./coachingThrottle.store.js";

/**
 * PHASE 4.2 — Coaching Control Engine
 *
 * PURPOSE:
 * - Decide which nudges should be amplified, observed, or suppressed
 * - Based on historical effectiveness
 *
 * ENTERPRISE GUARANTEES:
 * - Deterministic
 * - Idempotent (safe to re-run)
 * - Auditable
 * - Read-after-write safe
 */
export async function runCoachingControlEngine({
  workspaceId,
  month,
}) {
  // Aggregate effectiveness across ALL evaluated history up to this month
  const { rows } = await pool.query(
    `
    SELECT
      nudge_type,
      COUNT(*)::int                            AS total,
      COUNT(*) FILTER (WHERE outcome = 'positive')::int AS positive,
      COUNT(*) FILTER (WHERE outcome = 'negative')::int AS negative
    FROM workspace_coaching_effectiveness
    WHERE workspace_id = $1
      AND date_trunc('month', evaluated_at)
          <= date_trunc('month', $2::date)
    GROUP BY nudge_type
    `,
    [workspaceId, `${month}-01`]
  );

  const decisions = [];

  for (const row of rows) {
    const total = Number(row.total);

    // 🚫 Enterprise guard: insufficient signal
    if (total < COACHING_POLICY.MIN_SAMPLES) {
      continue;
    }

    const positive = Number(row.positive);
    const negative = Number(row.negative);

    const positiveRate =
      total === 0 ? 0 : Number((positive / total).toFixed(4));

    // 🎯 Policy-based decision
    let decision = "observe";

    if (positiveRate >= COACHING_POLICY.SUCCESS_THRESHOLD) {
      decision = "boost";
    } else if (positiveRate <= COACHING_POLICY.FAILURE_THRESHOLD) {
      decision = "suppress";
    }

    // 🔒 Persist decision (UPSERT = idempotent)
    await saveNudgeThrottle({
      workspaceId,
      nudgeType: row.nudge_type,
      decision,
      evaluatedMonth: month,
      metrics: {
        total,
        positive,
        negative,
        positiveRate,
        successThreshold: COACHING_POLICY.SUCCESS_THRESHOLD,
        failureThreshold: COACHING_POLICY.FAILURE_THRESHOLD,
        minSamples: COACHING_POLICY.MIN_SAMPLES,
      },
    });

    decisions.push({
      nudgeType: row.nudge_type,
      decision,
      positiveRate,
      totalSamples: total,
    });
  }

  return {
    workspaceId,
    month,
    evaluatedNudges: decisions.length,
    decisions,
  };
}

