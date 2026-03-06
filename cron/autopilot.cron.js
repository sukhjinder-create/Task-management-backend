// cron/autopilot.cron.js
import cron from "node-cron";
import pool from "../db.js";
import { runAutopilotAnalysis } from "../autopilot/autopilot.engine.js";
import { processAutoApprovals } from "../services/autopilot.service.js";

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
  // JOB 1: Run autopilot analysis every 30 minutes
  // ============================================
  cron.schedule("*/30 * * * *", async () => {
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
  console.log("  - Analysis: Every 30 minutes");
  console.log("  - Auto-approvals: Every 15 minutes");
}
