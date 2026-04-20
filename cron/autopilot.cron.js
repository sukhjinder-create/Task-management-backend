// cron/autopilot.cron.js
import cron from "node-cron";
import pool from "../db.js";
import { runAutopilotAnalysis } from "../autopilot/autopilot.engine.js";
import { processAutoApprovals } from "../services/autopilot.service.js";
import { notifyUser } from "../services/notification.service.js";

// ─── Working-day helpers ──────────────────────────────────────────────────────

/**
 * Returns true if `date` is a configured working day for the workspace.
 * Checks both the work_days schedule (day-of-week) AND declared holidays.
 *
 * Falls back to Mon–Fri (1–5) if the workspace has no schedule configured.
 */
async function isWorkingDayForWorkspace(workspaceId, date) {
  const { rows: scheduleRows } = await pool.query(
    `SELECT work_days FROM workspace_work_schedule WHERE workspace_id = $1`,
    [workspaceId]
  );
  // work_days uses JS DOW convention: 0=Sun, 1=Mon … 6=Sat
  const workDays = scheduleRows[0]?.work_days ?? [1, 2, 3, 4, 5];

  if (!workDays.includes(date.getDay())) return false;

  const dateStr = date.toISOString().slice(0, 10);
  const { rows: holidays } = await pool.query(
    `SELECT 1 FROM workspace_holidays WHERE workspace_id = $1 AND date = $2`,
    [workspaceId, dateStr]
  );
  return holidays.length === 0;
}

/**
 * Walks backwards from yesterday to find the most recent working day.
 * Returns the timestamp at standup-hour on that day (i.e., when the last
 * standup should have been posted) plus a human-readable period label.
 *
 * Examples:
 *   Monday  → { since: Friday 11:00,    label: "since Friday (Apr 3)" }
 *   Tuesday → { since: Monday 11:00,    label: "since yesterday"       }
 *   Tuesday (Monday was holiday) → { since: Friday 11:00, ... }
 */
async function getStandupLookbackSince(workspaceId, standupHour = 11) {
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 1); // start from yesterday

  for (let i = 0; i < 14; i++) {
    if (await isWorkingDayForWorkspace(workspaceId, cursor)) {
      const since = new Date(cursor);
      since.setHours(standupHour, 0, 0, 0);

      const isYesterday = i === 0;
      const dayName = cursor.toLocaleDateString("en-US", { weekday: "long" });
      const dateLabel = cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const periodLabel = isYesterday
        ? "since yesterday"
        : `since ${dayName} (${dateLabel})`;

      return { sinceTimestamp: since, periodLabel };
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  // Safety fallback — should never be reached in a normally configured workspace
  return {
    sinceTimestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
    periodLabel: "last 24 hours",
  };
}

async function notifyAdminsOfAutopilotRun(workspaceId, result) {
  try {
    const { rows: admins } = await pool.query(
      `SELECT id FROM users
       WHERE workspace_id = $1
         AND role = 'admin'
         AND (is_system IS NOT TRUE)`,
      [workspaceId]
    );

    const { actionsCreated = 0, pendingApproval = 0, autoApproved = 0 } = result || {};
    if (actionsCreated === 0) return; // no noise when nothing happened

    const parts = [];
    if (pendingApproval > 0) parts.push(`${pendingApproval} awaiting your approval`);
    if (autoApproved > 0)    parts.push(`${autoApproved} auto-approved`);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';
    const message = `Autopilot ran: ${actionsCreated} action${actionsCreated !== 1 ? 's' : ''} generated${detail}`;

    for (const { id: adminId } of admins) {
      await notifyUser({
        user_id:     adminId,
        type:        "autopilot_summary",
        message,
        workspaceId,
      });
    }
  } catch (err) {
    console.error("[notifications] autopilot summary failed:", err.message);
  }
}

/**
 * 🤖 AUTOPILOT CRON JOBS
 *
 * Two jobs:
 * 1. Analysis Runner - Scans workspaces and creates actions
 * 2. Auto-Approver - Executes expired pending actions
 */

export function startAutopilotCron() {
  console.log("🤖 Starting Autopilot cron jobs...");

  // ============================================
  // JOB 1: Run autopilot analysis every 4 hours
  // ============================================
  cron.schedule("0 */4 * * *", async () => {
    console.log("\n🤖 [CRON] Running autopilot analysis...");

    try {
      const { rows: workspaces } = await pool.query(`
        SELECT DISTINCT workspace_id
        FROM autopilot_settings
        WHERE enabled = true
          AND project_id IS NULL
      `);

      console.log(`Found ${workspaces.length} workspaces with autopilot enabled`);

      for (const ws of workspaces) {
        try {
          const result = await runAutopilotAnalysis({
            workspaceId: ws.workspace_id,
            projectId: null,
            skipStandup: true, // Standups run on dedicated daily cron at 11:00 AM
          });

          console.log(
            `✅ Workspace ${ws.workspace_id}: ${result.actionsCreated} actions created`
          );

          await notifyAdminsOfAutopilotRun(ws.workspace_id, result);
        } catch (err) {
          console.error(
            `❌ Failed to run autopilot for workspace ${ws.workspace_id}:`,
            err.message
          );
        }
      }
    } catch (err) {
      console.error("❌ Autopilot cron job failed:", err);
    }
  }, { timezone: "Asia/Kolkata" });

  // ============================================
  // JOB 2: Process auto-approvals every 15 minutes
  // ============================================
  cron.schedule("*/15 * * * *", async () => {
    console.log("\n🤖 [CRON] Processing auto-approvals...");

    try {
      const results = await processAutoApprovals();

      const executed = results.filter(r => r.status === 'executed').length;
      const failed = results.filter(r => r.status === 'failed').length;

      console.log(
        `✅ Auto-approvals: ${executed} executed, ${failed} failed`
      );
    } catch (err) {
      console.error("❌ Auto-approval cron job failed:", err);
    }
  }, { timezone: "Asia/Kolkata" });

  // ============================================
  // JOB 3: Generate & deliver daily standups at 11:00 AM every day
  // Skips workspaces where today is not a configured working day.
  // Lookback window stretches to cover activity since the previous working day.
  // ============================================
  cron.schedule("0 11 * * *", async () => {
    console.log("\n📋 [CRON] Generating daily standups (11:00 AM)...");

    try {
      const { rows: workspaces } = await pool.query(`
        SELECT DISTINCT workspace_id
        FROM autopilot_settings
        WHERE enabled = true
          AND auto_generate_standup = true
          AND project_id IS NULL
      `);

      console.log(`📋 [STANDUP] Found ${workspaces.length} workspace(s) with auto_generate_standup=true`);

      if (workspaces.length === 0) {
        console.log("📋 [STANDUP] No workspaces configured for standup — ensure autopilot_settings has enabled=true, auto_generate_standup=true, project_id IS NULL");
      }

      const today = new Date();

      for (const ws of workspaces) {
        try {
          // Skip if today is not a working day for this workspace
          const isWorking = await isWorkingDayForWorkspace(ws.workspace_id, today);
          if (!isWorking) {
            console.log(`⏭️  [STANDUP] Workspace ${ws.workspace_id}: today is not a working day — skipping`);
            continue;
          }

          // Dynamic lookback: covers activity since the last working day standup
          const { sinceTimestamp, periodLabel } = await getStandupLookbackSince(ws.workspace_id, 11);
          console.log(`📋 [STANDUP] Workspace ${ws.workspace_id}: generating standup (${periodLabel}, since ${sinceTimestamp.toISOString()})`);

          const result = await runAutopilotAnalysis({
            workspaceId: ws.workspace_id,
            projectId: null,
            skipStandup: false,
            sinceTimestamp,
            periodLabel,
            standupOnly: true,
          });
          console.log(`✅ [STANDUP] Workspace ${ws.workspace_id}: ${result.actionsCreated} action(s) created`);
        } catch (err) {
          console.error(`❌ [STANDUP] Workspace ${ws.workspace_id} failed:`, err.message);
          console.error(err.stack);
        }
      }
    } catch (err) {
      console.error("❌ Daily standup cron failed:", err);
    }
  }, { timezone: "Asia/Kolkata" });

  console.log("✅ Autopilot cron jobs started");
  console.log("  - Analysis: Every 4 hours (no standups)");
  console.log("  - Daily standups: Every day at 11:00 AM");
  console.log("  - Auto-approvals: Every 15 minutes");
}
