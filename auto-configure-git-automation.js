import pool from "./db.js";
import { autoConfigureWorkspaceGitAutomation } from "./integrations/git/git.automation.service.js";

async function run() {
  try {
    console.log("Auto-configuring advanced Git automation for all workspaces...");
    const { rows } = await pool.query(`
      SELECT DISTINCT workspace_id
      FROM projects
      WHERE workspace_id IS NOT NULL
    `);

    let totalProjects = 0;
    const results = [];
    for (const row of rows) {
      const workspaceId = row.workspace_id;
      const configured = await autoConfigureWorkspaceGitAutomation({
        workspaceId,
        actorId: null,
        repoFullName: null,
        minInferenceConfidence: 62,
        maxInferredTasks: 2,
      });
      totalProjects += configured.projectsConfigured;
      results.push(configured);
      console.log(`- workspace ${workspaceId}: ${configured.projectsConfigured} project(s) configured`);
    }

    console.log("Done.");
    console.log(`Workspaces: ${results.length}, Projects configured: ${totalProjects}`);
  } catch (error) {
    console.error("Auto-configure failed:", error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();

