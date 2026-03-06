import pool from "../db.js";
import { advancedForecast } from "../intelligence/forecast/forecast.engine.js";
import { getExecutionSnapshot }
  from "../intelligence/executionSnapshot.service.js";

export async function buildAIContext({
  workspaceId,
  scope,
  entityId
}) {
  const context = {
    scope,
    entityId
  };

  // ==========================
  // TASK CONTEXT
  // ==========================
  if (scope === "task") {

    if (!entityId) {
      throw new Error("Task ID (entityId) is required for task scope");
    }

    // First check if task exists at all
    const taskCheck = await pool.query(`
      SELECT id, workspace_id, status
      FROM tasks
      WHERE id = $1
      LIMIT 1
    `, [entityId]);

    if (!taskCheck.rows.length) {
      throw new Error(`Task with ID '${entityId}' does not exist in the database.`);
    }

    const taskWorkspaceId = taskCheck.rows[0].workspace_id;

    if (taskWorkspaceId !== workspaceId) {
      throw new Error(
        `Task belongs to a different workspace. Task workspace: '${taskWorkspaceId}', Your workspace: '${workspaceId}'. You can only query tasks within your own workspace.`
      );
    }

    // Now fetch full task details
    const taskRes = await pool.query(`
      SELECT *
      FROM tasks
      WHERE id = $1
        AND workspace_id = $2
      LIMIT 1
    `, [entityId, workspaceId]);

    const task = taskRes.rows[0];

    const logs = await pool.query(`
      SELECT action_type, old_value, new_value, created_at
      FROM task_activity_logs
      WHERE task_id = $1
      ORDER BY created_at ASC
    `, [entityId]);

    context.task = task;
    context.activity = logs.rows;

    return context;
  }

  // ==========================
  // PROJECT CONTEXT
  // ==========================
  if (scope === "project") {

    if (!entityId) {
      throw new Error("Project ID (entityId) is required for project scope");
    }

    // Verify project exists in workspace
    const projectCheck = await pool.query(`
      SELECT id FROM projects
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1
    `, [entityId, workspaceId]);

    if (!projectCheck.rows.length) {
      throw new Error(
        `Project not found. Either project ID '${entityId}' does not exist or it does not belong to this workspace.`
      );
    }

    const tasks = await pool.query(`
      SELECT status, due_date, assigned_to
      FROM tasks
      WHERE project_id = $1
        AND workspace_id = $2
    `, [entityId, workspaceId]);

    const overdue = tasks.rows.filter(t =>
      t.due_date &&
      new Date(t.due_date) < new Date() &&
      t.status !== "completed"
    );

    context.projectTasks = tasks.rows;
    context.overdueCount = overdue.length;
    context.totalTasks = tasks.rows.length;

    return context;
  }

  // ==========================
  // WORKSPACE CONTEXT
  // ==========================
  if (scope === "workspace") {

    const history = await pool.query(`
      SELECT month, AVG(score) as avg_score
      FROM workspace_monthly_scores
      WHERE workspace_id = $1
      GROUP BY month
      ORDER BY month ASC
      LIMIT 6
    `, [workspaceId]);

    const scoreHistory =
      history.rows.map(r => Number(r.avg_score) || 0);

    const executionSnapshot =
      await getExecutionSnapshot(workspaceId);

    const forecast =
      advancedForecast(scoreHistory, executionSnapshot);

    context.scoreHistory = scoreHistory;
    context.execution = executionSnapshot;
    context.forecast = forecast;

    return context;
  }

  return context;
}