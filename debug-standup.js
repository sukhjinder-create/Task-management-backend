// debug-standup.js — run with: node debug-standup.js
// Manually triggers standup generation for all workspaces and prints detailed output

import "dotenv/config";
import pool from "./db.js";
import { runAutopilotAnalysis } from "./autopilot/autopilot.engine.js";

const WORKSPACE_ID = "886da598-6ae9-4c6a-950a-dca35d7a0b65";

async function debugStandup() {
  console.log("=== STANDUP DEBUG ===\n");

  // 1. Check autopilot settings
  const { rows: settings } = await pool.query(
    `SELECT workspace_id, enabled, auto_generate_standup, project_id, mode, require_approval
     FROM autopilot_settings
     WHERE workspace_id = $1 AND project_id IS NULL`,
    [WORKSPACE_ID]
  );
  console.log("autopilot_settings:", JSON.stringify(settings, null, 2));

  if (!settings.length) {
    console.error("❌ No workspace-level autopilot settings found! This is the bug.");
    process.exit(1);
  }

  // 2. Check recent standup actions (last 7 days)
  const { rows: recent } = await pool.query(
    `SELECT id, status, proposed_changes->>'report_date' AS report_date,
            proposed_changes->>'project_name' AS project_name,
            created_at, executed_at
     FROM autopilot_actions
     WHERE workspace_id = $1 AND action_type = 'create_standup'
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC`,
    [WORKSPACE_ID]
  );
  console.log(`\nRecent standup actions (last 7 days): ${recent.length}`);
  recent.forEach(r => console.log(`  ${r.report_date} | ${r.status} | ${r.project_name}`));

  // 3. Check today's date calculation
  const today = new Date();
  const sinceTimestamp = new Date(today);
  sinceTimestamp.setDate(today.getDate() - 1);
  sinceTimestamp.setHours(11, 0, 0, 0);

  console.log(`\nToday: ${today.toISOString()}`);
  console.log(`Since: ${sinceTimestamp.toISOString()}`);
  console.log(`Today dayOfWeek: ${today.getDay()} (0=Sun, 1=Mon...6=Sat)`);

  // 4. Run the actual standup generation
  console.log("\n=== Running standup generation ===\n");
  try {
    const result = await runAutopilotAnalysis({
      workspaceId: WORKSPACE_ID,
      projectId: null,
      skipStandup: false,
      sinceTimestamp,
      periodLabel: "since yesterday (debug run)",
      standupOnly: true,
    });

    console.log("\n=== RESULT ===");
    console.log(`actionsCreated: ${result.actionsCreated}`);
    if (result.actions?.length) {
      result.actions.forEach(a => {
        console.log(`  action: ${a.action_type} | status: ${a.status} | project: ${a.proposed_changes?.project_name}`);
      });
    }
  } catch (err) {
    console.error("\n❌ runAutopilotAnalysis threw:", err.message);
    console.error(err.stack);
  }

  await pool.end();
}

debugStandup().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
