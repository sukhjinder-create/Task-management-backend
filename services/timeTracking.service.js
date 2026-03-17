import pool from "../db.js";

export async function logTime({ taskId, userId, workspaceId, hours, logDate, description }) {
  if (!hours || hours <= 0) throw new Error("Hours must be greater than 0");
  const { rows } = await pool.query(
    `INSERT INTO time_logs (task_id, user_id, workspace_id, hours, log_date, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [taskId, userId, workspaceId, hours, logDate || new Date().toISOString().slice(0, 10), description || null]
  );
  return rows[0];
}

export async function getTimeLogs({ taskId }) {
  const { rows } = await pool.query(
    `SELECT tl.*, u.username AS user_name
     FROM time_logs tl
     LEFT JOIN users u ON u.id = tl.user_id
     WHERE tl.task_id = $1
     ORDER BY tl.log_date DESC, tl.created_at DESC`,
    [taskId]
  );
  return rows;
}

export async function getTimeLogSummary({ taskId }) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(hours), 0)::float AS total_logged,
       COUNT(*)::int                  AS entry_count
     FROM time_logs WHERE task_id = $1`,
    [taskId]
  );
  const task = await pool.query(
    `SELECT estimation_hours FROM tasks WHERE id = $1`,
    [taskId]
  );
  return {
    ...rows[0],
    estimation_hours: task.rows[0]?.estimation_hours ?? null,
  };
}

export async function deleteTimeLog({ id, userId, workspaceId }) {
  const { rows } = await pool.query(
    `DELETE FROM time_logs WHERE id = $1 AND user_id = $2 AND workspace_id = $3 RETURNING id`,
    [id, userId, workspaceId]
  );
  if (!rows[0]) throw new Error("Log not found or not yours");
}

export async function updateEstimation({ taskId, workspaceId, estimationHours }) {
  const { rows } = await pool.query(
    `UPDATE tasks SET estimation_hours = $1 WHERE id = $2 AND workspace_id = $3 RETURNING id, estimation_hours`,
    [estimationHours, taskId, workspaceId]
  );
  if (!rows[0]) throw new Error("Task not found");
  return rows[0];
}

export async function getProjectTimeReport({ projectId, workspaceId }) {
  const { rows } = await pool.query(
    `SELECT
       t.id, t.task, t.estimation_hours,
       CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
            THEN p.project_code || '-' || t.ticket_number END AS display_id,
       COALESCE(SUM(tl.hours), 0)::float AS total_logged
     FROM tasks t
     LEFT JOIN time_logs tl ON tl.task_id = t.id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.project_id = $1 AND t.workspace_id = $2
     GROUP BY t.id, p.project_code
     ORDER BY total_logged DESC`,
    [projectId, workspaceId]
  );
  return rows;
}
