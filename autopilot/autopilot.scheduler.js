// autopilot/autopilot.scheduler.js
// Runs autopilot analysis every 4 hours for all workspaces that have it enabled.

import pool from "../db.js";
import { runAutopilotAnalysis } from "./autopilot.engine.js";
import { processAutoApprovals } from "../services/autopilot.service.js";

const INTERVAL_HOURS = 4;
const INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1000;

async function getEnabledWorkspaces() {
  const { rows } = await pool.query(`
    SELECT DISTINCT workspace_id
    FROM autopilot_settings
    WHERE enabled = true
  `);
  return rows.map(r => r.workspace_id);
}

async function runScheduledAutopilot() {
  console.log(`🤖 [Autopilot Scheduler] Running scheduled analysis at ${new Date().toISOString()}`);

  let workspaces = [];
  try {
    workspaces = await getEnabledWorkspaces();
  } catch (err) {
    console.error('🤖 [Autopilot Scheduler] Failed to fetch enabled workspaces:', err.message);
    return;
  }

  if (workspaces.length === 0) {
    console.log('🤖 [Autopilot Scheduler] No workspaces with autopilot enabled.');
    return;
  }

  console.log(`🤖 [Autopilot Scheduler] Processing ${workspaces.length} workspace(s)`);

  // Run each workspace sequentially to avoid overwhelming DB
  for (const workspaceId of workspaces) {
    try {
      const result = await runAutopilotAnalysis({ workspaceId, projectId: null });
      console.log(`🤖 [Autopilot Scheduler] Workspace ${workspaceId}: ${result.actionsCreated || 0} actions created`);
    } catch (err) {
      console.error(`🤖 [Autopilot Scheduler] Workspace ${workspaceId} failed:`, err.message);
    }
  }

  // Process auto-approvals that have expired
  try {
    const approvalResults = await processAutoApprovals();
    console.log(`🤖 [Autopilot Scheduler] Auto-approvals processed: ${approvalResults.length}`);
  } catch (err) {
    console.error('🤖 [Autopilot Scheduler] Auto-approval processing failed:', err.message);
  }
}

export function startAutopilotScheduler() {
  console.log(`🤖 [Autopilot Scheduler] Starting — runs every ${INTERVAL_HOURS} hours`);

  // Run once after a 30s delay on startup (to let server finish initializing)
  setTimeout(() => {
    runScheduledAutopilot().catch(err =>
      console.error('🤖 [Autopilot Scheduler] Initial run failed:', err.message)
    );
  }, 30_000);

  // Then run on interval
  const timer = setInterval(() => {
    runScheduledAutopilot().catch(err =>
      console.error('🤖 [Autopilot Scheduler] Scheduled run failed:', err.message)
    );
  }, INTERVAL_MS);

  // Prevent timer from keeping the process alive if server shuts down gracefully
  if (timer.unref) timer.unref();

  return timer;
}
