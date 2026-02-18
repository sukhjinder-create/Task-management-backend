import pool from "../db.js";
import { buildUserEvidence } from "../events/scoring/evidenceBuilder.js";
import { calculateScore } from "../events/scoring/scoreCalculator.js";
import { buildMonthlyEvidence } from "../events/scoring/evidenceBuilder.service.js";
import { saveMonthlyScore } from "../events/scoring/monthlyScore.store.js";
import { evaluateCoachingEffectiveness } from "../events/coaching/coachingEffectiveness.service.js";
import { runCoachingControlEngine } from "../events/coaching/control/coachingControl.engine.js";
import { runProjectMonthlyScoring } from "../events/scoring/projectMonthlyScore.service.js";
import { calculateProjectProductivity } from "../events/scoring/projectProductivity.engine.js";
import { saveProjectMonthlyScore } from "../events/scoring/projectMonthlyScore.store.js";

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

    const { startDate, endDate } = getMonthBoundaries(month);

const { rows: projectRows } = await pool.query(
  `
  SELECT DISTINCT t.project_id
  FROM tasks t
  WHERE t.assigned_to = $1
    AND t.workspace_id = $2
    AND t.created_at >= $3
    AND t.created_at < $4
  `,
  [user.id, workspaceId, startDate, endDate]
);

for (const proj of projectRows) {
  const projectId = proj.project_id;

  const { rows: projectTasks } = await pool.query(
    `
    SELECT status, due_date
    FROM tasks
    WHERE assigned_to = $1
      AND project_id = $2
      AND workspace_id = $3
      AND created_at >= $4
      AND created_at < $5
    `,
    [user.id, projectId, workspaceId, startDate, endDate]
  );

  const productivityScore = calculateProjectProductivity(
    projectTasks,
    endDate // pass month end
  );

  await saveProjectMonthlyScore({
    workspaceId,
    userId: user.id,
    projectId,
    month,
    score: productivityScore ?? 0, // HARD SAFETY
  });
}

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

// Coaching control
try {
  await runCoachingControlEngine({
    workspaceId,
    month,
  });
} catch (err) {
  console.error("[coaching-control] failed", err.message);
}

// Project scoring
try {
  await runProjectMonthlyScoring({
    workspaceId,
    month,
  });
} catch (err) {
  console.error("[project-monthly-scoring] failed", err.message);
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

function getMonthBoundaries(month) {
  const [year, m] = month.split("-").map(Number);

  const startDate = new Date(year, m - 1, 1);
  const endDate = new Date(year, m, 1); // first day next month

  return { startDate, endDate };
}
