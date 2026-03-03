import pool from "../../db.js";
import { saveMonthlyScore } from "./monthlyScore.store.js";
import { buildMonthlyEvidence } from "./evidenceBuilder.service.js";
import { getExecutionSnapshot }
  from "../../intelligence/executionSnapshot.service.js";

/**
 * Generates monthly score + evidence for ONE user
 * Deterministic, auditable, enterprise-safe
 */
export async function generateMonthlyScore({
  workspaceId,
  userId,
  month, // YYYY-MM
}) {
  // 1️⃣ Fetch raw events for this user & month
  const { rows: events } = await pool.query(
    `
    SELECT event_type
    FROM workspace_events
    WHERE workspace_id = $1
      AND actor_user_id = $2
      AND to_char(created_at, 'YYYY-MM') = $3
    `,
    [workspaceId, userId, month]
  );

  // 2️⃣ Build breakdown (pure facts)
  const breakdown = {
    activity: events.length,
    taskUpdates: events.filter(e =>
      e.event_type.startsWith("TASK")
    ).length,
  };
  // 🔥 execution productivity (cross-platform)
const execution =
  await getExecutionSnapshot(workspaceId);

const executionScore =
  Math.round(execution.completionRate * 100);

  // 3️⃣ Deterministic scoring (NO AI here)
  let activityScore = 50;

if (breakdown.activity >= 50) activityScore += 10;
if (breakdown.activity < 20) activityScore -= 8;

if (breakdown.taskUpdates >= 20) activityScore += 10;
if (breakdown.taskUpdates < 10) activityScore -= 6;

// clamp
activityScore = Math.max(0, Math.min(100, activityScore));

const score = Math.round(
  activityScore * 0.6 +
  executionScore * 0.4
);

  // 4️⃣ Build structured evidence (THIS is explanation quality)
  const evidence = buildMonthlyEvidence({
    month,
    baselineScore: 50,
    breakdown,
    score,
  });

  // 5️⃣ Reasoning stored as structured object (NOT free text)
  const reasoning = {
    scoreComputation: {
      baseline: 50,
      activity: breakdown.activity,
      taskUpdates: breakdown.taskUpdates,
      finalScore: score,
    },
    evidence,
  };

  // 6️⃣ Improvements come from evidence (not generic)
  const improvements = evidence.improvementLevers;

  // 7️⃣ Persist monthly score
  await saveMonthlyScore({
    workspaceId,
    userId,
    month,
    score,
    breakdown,
    reasoning,
    improvements,
  });
}
