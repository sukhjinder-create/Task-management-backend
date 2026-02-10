import pool from "../db.js";
import { generateMonthlyScore } from "../events/scoring/monthlyScoring.service.js";
import { generateMonthlyCoaching } from "../events/coaching/coachingScheduler.service.js";
import { generateAdminInsights } from "../events/admin/adminInsight.service.js";
import { generateExecutiveSummary } from "../events/executive/executiveSummary.service.js";

/**
 * Runs full monthly intelligence pipeline
 * Safe to re-run (idempotent by design)
 */
export async function runMonthlyIntelligence({
  month,          // e.g. "2026-02"
  previousMonth,  // e.g. "2026-01"
}) {
  console.log("🧠 Monthly Intelligence Cron started:", month);

  // 1️⃣ Fetch all active workspaces
  const { rows: workspaces } = await pool.query(
    `SELECT id FROM workspaces WHERE is_active = true`
  );

  for (const ws of workspaces) {
    const workspaceId = ws.id;
    console.log("▶ Workspace:", workspaceId);

    // 2️⃣ Fetch active users in workspace
    const { rows: users } = await pool.query(
      `
      SELECT id
      FROM users
      WHERE workspace_id = $1
        AND status = 'active'
      `,
      [workspaceId]
    );

    // ---- USER LEVEL ----
    for (const user of users) {
      const userId = user.id;

      // Monthly scoring
      await generateMonthlyScore({
        workspaceId,
        userId,
        month,
      });

      // Coaching nudges
      await generateMonthlyCoaching({
        workspaceId,
        userId,
        month,
      });
    }

    // ---- WORKSPACE LEVEL ----
    await generateAdminInsights({
      workspaceId,
      month,
    });

    await generateExecutiveSummary({
      workspaceId,
      month,
      previousMonth,
    });
  }

  console.log("✅ Monthly Intelligence Cron completed:", month);
}
