import cron from "node-cron";
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

/**
 * Schedules two recurring intelligence runs:
 *
 *  1. 1st of every month @ 02:00 — official end-of-month score for the
 *     month that just closed (authoritative record).
 *
 *  2. Every Sunday @ 03:00 — mid-month refresh for the current month so
 *     scores never go more than 7 days stale. Idempotent UPSERT keeps this safe.
 */
export function startMonthlyIntelligenceCron() {
  // Helper: returns "YYYY-MM" for an offset of N months from today
  const monthStr = (offsetMonths = 0) => {
    const d = new Date();
    d.setMonth(d.getMonth() + offsetMonths);
    return d.toISOString().slice(0, 7);
  };

  // Official end-of-month run — scores the month that just ended
  cron.schedule("0 2 1 * *", async () => {
    const month         = monthStr(-1); // previous month
    const previousMonth = monthStr(-2);
    console.log(`[intelligence-cron] End-of-month run for ${month}`);
    try {
      await runMonthlyIntelligence({ month, previousMonth });
    } catch (err) {
      console.error("[intelligence-cron] End-of-month run failed:", err);
    }
  });

  // Weekly mid-month refresh — keeps current-month scores fresh
  cron.schedule("0 3 * * 0", async () => {
    const month         = monthStr(0);  // current month
    const previousMonth = monthStr(-1);
    console.log(`[intelligence-cron] Weekly refresh for ${month}`);
    try {
      await runMonthlyIntelligence({ month, previousMonth });
    } catch (err) {
      console.error("[intelligence-cron] Weekly refresh failed:", err);
    }
  });

  console.log("✅ Monthly Intelligence cron started (end-of-month + weekly refresh)");
}
