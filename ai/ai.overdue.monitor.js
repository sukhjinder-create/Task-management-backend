import pool from "../db.js";
import { notifyUser } from "../services/notification.service.js";

export async function runOverdueAIMonitor(workspaceId) {

  const overdue = await pool.query(`
    SELECT id, assigned_to, project_id
    FROM tasks
    WHERE workspace_id = $1
      AND due_date < now()
      AND status != 'completed'
  `, [workspaceId]);

  for (const task of overdue.rows) {

    await notifyUser({
      user_id: task.assigned_to,
      type: "ai_overdue_alert",
      message:
        "Task is overdue and may impact execution stability.",
      task_id: task.id,
      project_id: task.project_id,
      workspaceId
    });
  }
}