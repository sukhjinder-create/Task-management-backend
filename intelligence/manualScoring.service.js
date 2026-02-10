import pool from "../db.js";
import { v4 as uuid } from "uuid";

/**
 * Manual monthly scoring (ADMIN ONLY)
 * This simulates what cron will later do.
 */
export async function runManualMonthlyScoring({
  workspaceId,
  month,
  triggeredBy,
}) {
  // 1️⃣ Get all users in workspace
  const { rows: users } = await pool.query(
    `
    SELECT id
    FROM users
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );

  // 2️⃣ For each user, generate a sample score
  for (const user of users) {
    await pool.query(
      `
      INSERT INTO workspace_monthly_scores
        (id, workspace_id, user_id, month, score, breakdown, reasoning, improvements)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (workspace_id, user_id, month)
      DO NOTHING
      `,
      [
  uuid(),
  workspaceId,
  user.id,
  month,
  Math.floor(60 + Math.random() * 40),

  JSON.stringify({
    attendance: "good",
    taskCompletion: "average",
    collaboration: "good",
  }),

  JSON.stringify({
    summary:
      "Performance is stable with good attendance and collaboration. Task completion can be improved.",
    evidence: {
      attendance: "90% present",
      tasks: "Some delays observed",
    },
  }),

  JSON.stringify([
    {
      type: "task_focus",
      message: "Try closing tasks before due dates",
      expectedImpact: "Higher delivery consistency",
    },
  ]),
]  
    );
  }

  return {
    usersProcessed: users.length,
    month,
    triggeredBy,
  };
}
