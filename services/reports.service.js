// services/reports.service.js
import pool from "../db.js";

export async function getProjectReport({
  workspaceId,
  projectName,
  fromDate,
  toDate,
}) {
  // 1️⃣ Resolve project ID from name
  const projectRes = await pool.query(
    `
    SELECT id
    FROM projects
    WHERE LOWER(name) = LOWER($1)
      AND workspace_id = $2
    LIMIT 1
    `,
    [projectName, workspaceId]
  );

  // ❗ Project NOT found → return explicit empty state
  if (!projectRes.rows.length) {
    return {
      projectName,
      empty: true,
      reason: "project_not_found",
      summary: null,
      tasks: [],
    };
  }

  const projectId = projectRes.rows[0].id;

  // 2️⃣ Fetch tasks in date range
  const tasksRes = await pool.query(
    `
    SELECT
      t.id,
      t.task,
      t.status,
      t.created_at,
      u.username AS assignee
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.project_id = $1
      AND t.created_at BETWEEN $2 AND $3
    ORDER BY t.created_at ASC
    `,
    [projectId, fromDate, toDate]
  );

  const tasks = tasksRes.rows;

  // ❗ No tasks in range → valid empty state
  if (!tasks.length) {
    return {
      projectName,
      empty: true,
      reason: "no_tasks_in_range",
      summary: {
        totalTasks: 0,
        completed: 0,
        pending: 0,
      },
      tasks: [],
    };
  }

  // 3️⃣ Build summary
  const summary = {
    totalTasks: tasks.length,
    completed: tasks.filter(t => t.status === "completed").length,
    pending: tasks.filter(t => t.status !== "completed").length,
  };

  // ✅ Normal success response
  return {
    projectName,
    empty: false,
    summary,
    tasks,
  };
}
