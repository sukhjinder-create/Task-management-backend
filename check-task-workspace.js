/**
 * Check Task Workspace - Helper script to verify which workspace a task belongs to
 *
 * Usage: node check-task-workspace.js <task-id>
 */

import pool from "./db.js";

const taskId = process.argv[2];

if (!taskId) {
  console.log("❌ Error: Please provide a task ID");
  console.log("\nUsage:");
  console.log("  node check-task-workspace.js <task-id>");
  console.log("\nExample:");
  console.log("  node check-task-workspace.js 3443ded0-1892-4f48-be1e-c381c9a957b3");
  process.exit(1);
}

async function checkTaskWorkspace() {
  try {
    console.log(`🔍 Checking task: ${taskId}\n`);

    // Get task details
    const task = await pool.query(`
      SELECT
        t.id,
        t.task,
        t.status,
        t.workspace_id,
        t.project_id,
        t.assigned_to,
        p.name as project_name,
        w.name as workspace_name,
        u.username as assigned_username
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.id = $1
      LIMIT 1
    `, [taskId]);

    if (task.rows.length === 0) {
      console.log("❌ Task not found in database");
      console.log(`   Task ID: ${taskId}`);
      console.log("\n💡 Possible reasons:");
      console.log("   - Task ID is incorrect");
      console.log("   - Task has been deleted");
      process.exit(1);
    }

    const t = task.rows[0];

    console.log("✅ TASK FOUND");
    console.log("═══════════════════════════════════════════\n");

    console.log("📋 Task Details:");
    console.log(`   Title: ${t.task}`);
    console.log(`   Status: ${t.status}`);
    console.log(`   Assigned to: ${t.assigned_username || 'Unassigned'}`);
    console.log("");

    console.log("📁 Project:");
    console.log(`   Name: ${t.project_name || 'No project'}`);
    console.log(`   ID: ${t.project_id || 'N/A'}`);
    console.log("");

    console.log("🏢 Workspace:");
    console.log(`   Name: ${t.workspace_name || 'Unknown'}`);
    console.log(`   ID: ${t.workspace_id}`);
    console.log("");

    // Check activity logs
    const logs = await pool.query(`
      SELECT COUNT(*) as count
      FROM task_activity_logs
      WHERE task_id = $1
    `, [taskId]);

    console.log("📊 Activity Logs:");
    console.log(`   Total logs: ${logs.rows[0].count}`);
    console.log("");

    console.log("═══════════════════════════════════════════");
    console.log("🧪 TO QUERY THIS TASK:");
    console.log("═══════════════════════════════════════════\n");

    console.log("1. Make sure you're authenticated to workspace:");
    console.log(`   ${t.workspace_name} (${t.workspace_id})`);
    console.log("");

    console.log("2. Use this curl command:");
    console.log(`
curl -X POST http://localhost:3000/ai/intelligence-query \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "scope": "task",
    "entityId": "${taskId}",
    "question": "Summarize this task history"
  }'`);
    console.log("");

    console.log("💡 NOTE:");
    console.log("   Your JWT token MUST be for workspace: " + t.workspace_id);
    console.log("   If you're getting 'Task not found', you're authenticated");
    console.log("   to a different workspace.");

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

checkTaskWorkspace();
