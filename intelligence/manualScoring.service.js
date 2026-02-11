import pool from "../db.js";
import { buildUserEvidence } from "../events/scoring/evidenceBuilder.js";
import { calculateScore } from "../events/scoring/scoreCalculator.js";
import { buildMonthlyEvidence } from "../events/scoring/evidenceBuilder.service.js";
import { saveMonthlyScore } from "../events/scoring/monthlyScore.store.js";
import { evaluateCoachingEffectiveness } from "../events/coaching/coachingEffectiveness.service.js";
import { runCoachingControlEngine } from "../events/coaching/control/coachingControl.engine.js";

/**
 * Runs deterministic monthly scoring for a workspace
 * ENTERPRISE GUARANTEES:
 * - Deterministic
 * - Idempotent (UPSERT)
 * - Auditable
 * - Safe to re-run
 */
export async function runManualMonthlyScoring({
  workspaceId,
  month,
  triggeredBy,
}) {
  // 1️⃣ Get all active users in workspace
  const { rows: users } = await pool.query(
    `
    SELECT id
    FROM users
    WHERE workspace_id = $1
      AND role != 'superadmin'
    `,
    [workspaceId]
  );

  const results = [];

  // 🔢 Derive previous month safely (enterprise-safe)
  const previousMonth = getPreviousMonth(month);

  for (const user of users) {
    // 2️⃣ Build evidence (Step 2.2)
    const { metrics, evidence } = await buildUserEvidence({
      workspaceId,
      userId: user.id,
      month,
    });

    // 3️⃣ Calculate score (Step 2.1)
    const scoreResult = calculateScore(metrics);

    // 4️⃣ Build explanation (deterministic)
    const explanation = buildMonthlyEvidence({
      month,
      baselineScore: 50,
      breakdown: scoreResult.breakdown,
      score: scoreResult.score,
    });

    // 5️⃣ Persist monthly score (UPSERT SAFE)
    await saveMonthlyScore({
      workspaceId,
      userId: user.id,
      month,
      score: scoreResult.score,
      breakdown: scoreResult.breakdown,
      reasoning: {
        metrics,
        evidence,
        explanation,
      },
      improvements: explanation.improvementLevers,
    });

    // 6️⃣ 🔥 PHASE 4 — Coaching effectiveness evaluation
    // This MUST NOT block scoring
    if (previousMonth) {
      try {
        await evaluateCoachingEffectiveness({
          workspaceId,
          userId: user.id,
          previousMonth,
          currentMonth: month,
        });
      } catch (err) {
        // Enterprise rule: intelligence failure must not break scoring
        console.error(
          "[coaching-effectiveness] failed",
          {
            workspaceId,
            userId: user.id,
            previousMonth,
            currentMonth: month,
            error: err.message,
          }
        );
      }
    }

    results.push({
      userId: user.id,
      score: scoreResult.score,
    });
  }

  // 7️⃣ PHASE 4.2 — Coaching Control Engine (WORKSPACE LEVEL)
try {
  await runCoachingControlEngine({
    workspaceId,
    month,
  });
} catch (err) {
  console.error("[coaching-control] failed", {
    workspaceId,
    month,
    error: err.message,
  });
}

  return {
    workspaceId,
    month,
    scoredUsers: results.length,
    results,
    triggeredBy,
  };
}

/* =========================================================
   HELPERS (ENTERPRISE-SAFE)
========================================================= */

function getPreviousMonth(month) {
  // month format: YYYY-MM
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return null;

  if (m === 1) {
    return `${year - 1}-12`;
  }

  return `${year}-${String(m - 1).padStart(2, "0")}`;
}
