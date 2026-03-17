// cron/autopilot.cron.js
import cron from "node-cron";
import pool from "../db.js";
import { runAutopilotAnalysis } from "../autopilot/autopilot.engine.js";
import { processAutoApprovals } from "../services/autopilot.service.js";
import { notifyUser } from "../services/notification.service.js";

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
      // Get all workspaces with autopilot enabled
      const { rows: workspaces } = await pool.query(`
        SELECT DISTINCT workspace_id
        FROM autopilot_settings
        WHERE enabled = true
      `);

      console.log(`Found ${workspaces.length} workspaces with autopilot enabled`);

      for (const ws of workspaces) {
        try {
          const result = await runAutopilotAnalysis({
            workspaceId: ws.workspace_id,
            projectId: null, // Run for entire workspace
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
  });

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
  });

  console.log("✅ Autopilot cron jobs started");
  console.log("  - Analysis: Every 4 hours");
  console.log("  - Auto-approvals: Every 15 minutes");
}
