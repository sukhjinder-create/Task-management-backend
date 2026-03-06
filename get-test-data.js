/**
 * Get Test Data - Helper script to find valid IDs for testing
 *
 * This script helps you find real workspace, project, and task IDs
 * from your database to use for testing the Strategic Intelligence API
 */

import pool from "./db.js";

async function getTestData() {
  console.log("🔍 Fetching test data from database...\n");

  try {
    // Get workspaces
    console.log("═══════════════════════════════════════════");
    console.log("📊 WORKSPACES");
    console.log("═══════════════════════════════════════════");

    const workspaces = await pool.query(`
      SELECT id, name
      FROM workspaces
      ORDER BY created_at DESC
      LIMIT 5
    `);

    if (workspaces.rows.length === 0) {
      console.log("❌ No workspaces found");
    } else {
      workspaces.rows.forEach((ws, idx) => {
        console.log(`${idx + 1}. ${ws.name}`);
        console.log(`   ID: ${ws.id}`);
        console.log("");
      });
    }

    if (workspaces.rows.length > 0) {
      const workspaceId = workspaces.rows[0].id;
      console.log(`✅ Using workspace: ${workspaces.rows[0].name}`);
      console.log(`   ID: ${workspaceId}\n`);

      // Get projects
      console.log("═══════════════════════════════════════════");
      console.log("📁 PROJECTS");
      console.log("═══════════════════════════════════════════");

      const projects = await pool.query(`
        SELECT id, name, project_code, created_at
        FROM projects
        WHERE workspace_id = $1
        ORDER BY created_at DESC
        LIMIT 5
      `, [workspaceId]);

      if (projects.rows.length === 0) {
        console.log("❌ No projects found in this workspace");
      } else {
        projects.rows.forEach((proj, idx) => {
          console.log(`${idx + 1}. ${proj.name}${proj.project_code ? ` [${proj.project_code}]` : ''}`);
          console.log(`   ID: ${proj.id}`);
          console.log("");
        });
      }

      // Get tasks
      console.log("═══════════════════════════════════════════");
      console.log("✅ TASKS");
      console.log("═══════════════════════════════════════════");

      const tasks = await pool.query(`
        SELECT t.id, t.task, t.status, t.workspace_id, p.name as project_name
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.workspace_id = $1
        ORDER BY t.created_at DESC
        LIMIT 10
      `, [workspaceId]);

      if (tasks.rows.length === 0) {
        console.log("❌ No tasks found in this workspace");
        console.log(`⚠️  Make sure you're looking at workspace: ${workspaceId}`);
      } else {
        console.log(`Found ${tasks.rows.length} tasks in this workspace:\n`);
        tasks.rows.forEach((task, idx) => {
          console.log(`${idx + 1}. ${task.task} (${task.status})`);
          console.log(`   Project: ${task.project_name || "N/A"}`);
          console.log(`   Task ID: ${task.id}`);
          console.log(`   ✅ Belongs to current workspace: ${workspaceId}`);
          console.log("");
        });
      }

      // Generate test commands
      console.log("\n═══════════════════════════════════════════");
      console.log("🧪 TEST COMMANDS");
      console.log("═══════════════════════════════════════════\n");

      console.log("1️⃣  WORKSPACE QUERY:");
      console.log("─────────────────────────────────────────────");
      console.log(`curl -X POST http://localhost:3000/ai/intelligence-query \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "scope": "workspace",
    "question": "What are the operational risks this month?"
  }'`);
      console.log("");

      if (projects.rows.length > 0) {
        const projectId = projects.rows[0].id;
        console.log("2️⃣  PROJECT QUERY:");
        console.log("─────────────────────────────────────────────");
        console.log(`curl -X POST http://localhost:3000/ai/intelligence-query \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "scope": "project",
    "entityId": "${projectId}",
    "question": "Why is this project delayed?"
  }'`);
        console.log("");
      }

      if (tasks.rows.length > 0) {
        const taskId = tasks.rows[0].id;
        console.log("3️⃣  TASK QUERY:");
        console.log("─────────────────────────────────────────────");
        console.log(`curl -X POST http://localhost:3000/ai/intelligence-query \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "scope": "task",
    "entityId": "${taskId}",
    "question": "Summarize this task history"
  }'`);
        console.log("");
      }

      // Check for activity logs
      console.log("\n═══════════════════════════════════════════");
      console.log("📋 ACTIVITY LOG STATUS");
      console.log("═══════════════════════════════════════════");

      const logCount = await pool.query(`
        SELECT COUNT(*) as count
        FROM task_activity_logs
        WHERE workspace_id = $1
      `, [workspaceId]);

      console.log(`Total activity logs: ${logCount.rows[0].count}`);

      if (logCount.rows[0].count === "0") {
        console.log("⚠️  No activity logs found. Create some tasks or modify existing ones to generate logs.");
      } else {
        const sampleLogs = await pool.query(`
          SELECT action_type, COUNT(*) as count
          FROM task_activity_logs
          WHERE workspace_id = $1
          GROUP BY action_type
          ORDER BY count DESC
        `, [workspaceId]);

        console.log("\nActivity types:");
        sampleLogs.rows.forEach(log => {
          console.log(`  - ${log.action_type}: ${log.count}`);
        });
      }
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

getTestData();
