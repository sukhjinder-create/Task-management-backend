import cron from "node-cron";
import pool from "../db.js";
import { sendPerformanceReviewEmail } from "../services/email.service.js";
import { notifyUser } from "../services/notification.service.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

/**
 * Auto-assign reviews for a cycle:
 *  1. Self-review      — every workspace member reviews themselves
 *  2. Manager review   — manager reviews each direct report (if manager_id set)
 *  3. Peer reviews     — each member randomly reviews `peerCount` colleagues
 * Idempotent: ON CONFLICT DO NOTHING, safe to re-run.
 */
async function autoAssignReviews(cycleId, workspaceId, peerCount = 2) {
  const { rows: members } = await pool.query(
    `SELECT wu.user_id, wu.manager_id, u.email, u.username
     FROM workspace_users wu
     JOIN users u ON u.id = wu.user_id
     WHERE wu.workspace_id = $1`,
    [workspaceId]
  );
  if (members.length === 0) return 0;

  const { rows: cycleRows } = await pool.query(
    `SELECT name, end_date FROM review_cycles WHERE id = $1`,
    [cycleId]
  );
  const cycle = cycleRows[0];
  if (!cycle) return 0;

  // 1. Self-reviews
  for (const m of members) {
    await pool.query(
      `INSERT INTO performance_reviews (cycle_id, reviewee_id, reviewer_id, type)
       VALUES ($1, $2, $2, 'self')
       ON CONFLICT (cycle_id, reviewee_id, reviewer_id, type) DO NOTHING`,
      [cycleId, m.user_id]
    );
  }

  // 2. Manager reviews
  for (const m of members) {
    if (!m.manager_id) continue;
    await pool.query(
      `INSERT INTO performance_reviews (cycle_id, reviewee_id, reviewer_id, type)
       VALUES ($1, $2, $3, 'manager')
       ON CONFLICT (cycle_id, reviewee_id, reviewer_id, type) DO NOTHING`,
      [cycleId, m.user_id, m.manager_id]
    );
  }

  // 3. Peer reviews — each person reviews N random others
  if (peerCount > 0 && members.length > 2) {
    for (const m of members) {
      const eligible = members.filter(
        p => p.user_id !== m.user_id && p.user_id !== m.manager_id
      );
      const peers = eligible
        .sort(() => 0.5 - Math.random())
        .slice(0, Math.min(peerCount, eligible.length));
      for (const peer of peers) {
        await pool.query(
          `INSERT INTO performance_reviews (cycle_id, reviewee_id, reviewer_id, type)
           VALUES ($1, $2, $3, 'peer')
           ON CONFLICT (cycle_id, reviewee_id, reviewer_id, type) DO NOTHING`,
          [cycleId, m.user_id, peer.user_id]
        );
      }
    }
  }

  // 4. Notify every unique reviewer
  const { rows: reviewers } = await pool.query(
    `SELECT pr.reviewer_id, u.email, u.username,
            COUNT(pr.id) AS review_count
     FROM performance_reviews pr
     JOIN users u ON u.id = pr.reviewer_id
     WHERE pr.cycle_id = $1
     GROUP BY pr.reviewer_id, u.email, u.username`,
    [cycleId]
  );

  for (const r of reviewers) {
    sendPerformanceReviewEmail({
      to: r.email,
      username: r.username,
      cycleName: cycle.name,
      dueDate: cycle.end_date,
      reviewUrl: `${FRONTEND_URL}/reviews`,
      reviewCount: Number(r.review_count),
    }).catch(() => {});

    notifyUser({
      user_id: r.reviewer_id,
      type: "review_assigned",
      message: `Review cycle "${cycle.name}" is open — you have ${r.review_count} review${r.review_count > 1 ? "s" : ""} to complete`,
      workspaceId,
    }).catch(() => {});
  }

  return reviewers.length;
}

/**
 * Return the quarter name + date range for the given date.
 */
function getQuarterInfo(date = new Date()) {
  const year  = date.getFullYear();
  const q     = Math.floor(date.getMonth() / 3); // 0-3
  const names = ["Q1", "Q2", "Q3", "Q4"];
  const starts = [0, 3, 6, 9];   // month index of quarter start
  const ends   = [2, 5, 8, 11];  // month index of quarter end
  const startDate = new Date(year, starts[q], 1);
  const endDate   = new Date(year, ends[q] + 1, 0); // last day of end month
  return {
    name:     `${names[q]} ${year} Performance Review`,
    type:     "quarterly",
    startStr: startDate.toISOString().slice(0, 10),
    endStr:   endDate.toISOString().slice(0, 10),
  };
}

export function startReviewsCron() {

  // ── 1. Auto-create + activate quarterly cycles ────────────────────────────
  //   Runs at 01:30 on 1st of January, April, July, October
  cron.schedule("30 1 1 1,4,7,10 *", async () => {
    console.log("[reviews-cron] Auto-creating quarterly review cycles");
    try {
      const { rows: workspaces } = await pool.query(
        `SELECT id FROM workspaces WHERE is_active = true`
      );
      const q = getQuarterInfo();

      for (const ws of workspaces) {
        const { rows: existing } = await pool.query(
          `SELECT id FROM review_cycles WHERE workspace_id = $1 AND name = $2`,
          [ws.id, q.name]
        );
        if (existing.length > 0) continue; // already exists

        const { rows: inserted } = await pool.query(
          `INSERT INTO review_cycles
             (workspace_id, name, type, start_date, end_date, status, auto_generated, peer_review_count)
           VALUES ($1,$2,$3,$4,$5,'active',true,2)
           RETURNING id, peer_review_count`,
          [ws.id, q.name, q.type, q.startStr, q.endStr]
        );

        if (inserted[0]) {
          const n = await autoAssignReviews(inserted[0].id, ws.id, inserted[0].peer_review_count);
          console.log(`[reviews-cron] Created "${q.name}" workspace=${ws.id} — ${n} reviewers`);
        }
      }
    } catch (err) {
      console.error("[reviews-cron] Auto-create error:", err.message);
    }
  });

  // ── 2. Daily 06:00 — activate draft cycles whose start_date has arrived ──
  cron.schedule("0 6 * * *", async () => {
    console.log("[reviews-cron] Activating due draft cycles");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: cycles } = await pool.query(
        `UPDATE review_cycles SET status = 'active'
         WHERE status = 'draft' AND start_date <= $1
         RETURNING id, workspace_id, name, peer_review_count`,
        [today]
      );
      for (const c of cycles) {
        const n = await autoAssignReviews(c.id, c.workspace_id, c.peer_review_count || 2);
        console.log(`[reviews-cron] Activated "${c.name}" — ${n} reviewers notified`);
      }
    } catch (err) {
      console.error("[reviews-cron] Activation error:", err.message);
    }
  });

  // ── 3. Daily 09:00 — send deadline reminders (7 days and 1 day before) ──
  cron.schedule("0 9 * * *", async () => {
    console.log("[reviews-cron] Checking review reminders");
    try {
      const today = new Date();

      const d7 = new Date(today); d7.setDate(d7.getDate() + 7);
      const d1 = new Date(today); d1.setDate(d1.getDate() + 1);
      const d7str = d7.toISOString().slice(0, 10);
      const d1str = d1.toISOString().slice(0, 10);

      const { rows: cycles7 } = await pool.query(
        `UPDATE review_cycles SET reminder_sent_7d = true
         WHERE status = 'active' AND end_date = $1 AND reminder_sent_7d IS NOT TRUE
         RETURNING id, workspace_id, name, end_date`,
        [d7str]
      );
      const { rows: cycles1 } = await pool.query(
        `UPDATE review_cycles SET reminder_sent_1d = true
         WHERE status = 'active' AND end_date = $1 AND reminder_sent_1d IS NOT TRUE
         RETURNING id, workspace_id, name, end_date`,
        [d1str]
      );

      const sendReminders = async (cycles, daysLeft) => {
        for (const c of cycles) {
          const { rows: pending } = await pool.query(
            `SELECT pr.reviewer_id, u.email, u.username,
                    COUNT(pr.id) AS pending_count
             FROM performance_reviews pr
             JOIN users u ON u.id = pr.reviewer_id
             WHERE pr.cycle_id = $1 AND pr.status != 'submitted'
             GROUP BY pr.reviewer_id, u.email, u.username`,
            [c.id]
          );
          for (const r of pending) {
            sendPerformanceReviewEmail({
              to: r.email,
              username: r.username,
              cycleName: c.name,
              dueDate: c.end_date,
              reviewUrl: `${FRONTEND_URL}/reviews`,
              isReminder: true,
              daysLeft,
              pendingCount: Number(r.pending_count),
            }).catch(() => {});
            notifyUser({
              user_id: r.reviewer_id,
              type: "review_reminder",
              message: `⏰ "${c.name}" closes in ${daysLeft} day${daysLeft > 1 ? "s" : ""} — ${r.pending_count} review${r.pending_count > 1 ? "s" : ""} still pending`,
              workspaceId: c.workspace_id,
            }).catch(() => {});
          }
        }
      };

      await sendReminders(cycles7, 7);
      await sendReminders(cycles1, 1);
    } catch (err) {
      console.error("[reviews-cron] Reminder error:", err.message);
    }
  });

  // ── 4. Daily 01:00 — auto-complete cycles past their end_date ────────────
  cron.schedule("0 1 * * *", async () => {
    console.log("[reviews-cron] Auto-completing expired cycles");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: expired } = await pool.query(
        `UPDATE review_cycles SET status = 'completed'
         WHERE status = 'active' AND end_date < $1
         RETURNING id, workspace_id, name`,
        [today]
      );
      for (const c of expired) {
        console.log(`[reviews-cron] Completed cycle: ${c.name}`);

        const { rows: stats } = await pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status = 'submitted') AS submitted,
                  ROUND(AVG(overall_score) FILTER (WHERE status = 'submitted'), 1) AS avg_score
           FROM performance_reviews WHERE cycle_id = $1`,
          [c.id]
        );
        const s = stats[0];
        const msg = `✅ "${c.name}" closed — ${s.submitted}/${s.total} reviews submitted${s.avg_score ? `, avg ${s.avg_score}/5` : ""}`;

        const { rows: admins } = await pool.query(
          `SELECT u.id FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id
           WHERE wu.workspace_id = $1 AND wu.role IN ('admin','owner')`,
          [c.workspace_id]
        );
        for (const a of admins) {
          notifyUser({ user_id: a.id, type: "review_cycle_complete", message: msg, workspaceId: c.workspace_id }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[reviews-cron] Auto-complete error:", err.message);
    }
  });

  console.log("[reviews-cron] ✅ Review automation started");
}

// Export helper so routes can trigger assignment manually
export { autoAssignReviews, getQuarterInfo };
