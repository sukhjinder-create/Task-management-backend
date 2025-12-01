// services/task.service.js
import pool from "../db.js";
import { notifyUser } from "./notification.service.js";

/**
 * NOTE: make sure you have this in DB:
 *
 * ALTER TABLE tasks
 *   ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
 */

// Get a single task by id
export async function getTaskById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) {
    throw new Error("Task not found");
  }
  return rows[0];
}

/**
 * Create a task
 * description is stored in the tasks.description column
 * priority is optional, defaults to "medium"
 */
export async function createTask({
  task,
  project_id,
  status = "pending",
  added_by,
  assigned_to = null,
  due_date = null,
  description = "",
  priority = "medium",
}) {
  if (!task || !project_id || !added_by) {
    throw new Error("task, project_id and added_by are required");
  }

  const assigned = assigned_to || null;

  const query = `
    INSERT INTO tasks (task, project_id, status, priority, added_by, assigned_to, due_date, description)
    VALUES ($1,       $2,         $3,     $4,       $5,       $6,          $7,      $8)
    RETURNING *;
  `;
  const values = [
    task,
    project_id,
    status,
    priority || "medium",
    added_by,
    assigned,
    due_date,
    description || "",
  ];

  const { rows } = await pool.query(query, values);
  const created = rows[0];

  // Notify assignee if there is one
  if (created.assigned_to) {
    await notifyUser({
      user_id: created.assigned_to,
      type: "task_assigned",
      message: `You have been assigned a new task: "${created.task}"`,
      task_id: created.id,
      project_id: created.project_id,
    });
  }

  return created;
}

/**
 * Get tasks for a project, filtered by role:
 * - admin/manager: all tasks in the project (optionally filtered)
 * - user: only tasks assigned_to that user
 *
 * filters:
 *  - status
 *  - priority
 *  - assigned_to (ignored for normal users)
 *  - overdue: true/false
 */
export async function getTasksByProjectForUser(projectId, user, filters = {}) {
  const values = [projectId];
  let idx = 2;

  let query = `
    SELECT *
    FROM tasks
    WHERE project_id = $1
  `;

  // Normal user → only tasks assigned to themselves
  if (user.role === "user") {
    query += ` AND assigned_to = $${idx}`;
    values.push(user.id);
    idx++;
  } else if (filters.assigned_to) {
    // Admin / manager can filter by assignee
    query += ` AND assigned_to = $${idx}`;
    values.push(filters.assigned_to);
    idx++;
  }

  if (filters.status) {
    query += ` AND status = $${idx}`;
    values.push(filters.status);
    idx++;
  }

  if (filters.priority) {
    query += ` AND priority = $${idx}`;
    values.push(filters.priority);
    idx++;
  }

  if (filters.overdue === true) {
    query += ` AND due_date IS NOT NULL 
               AND due_date < NOW()::date 
               AND status != 'completed'`;
  }

  query += ` ORDER BY created_at DESC`;

  const { rows } = await pool.query(query, values);
  return rows;
}

/**
 * Update a task as admin/manager:
 * can change title, status, assigned_to, due_date, description, priority
 */
export async function updateTaskAsAdminOrManager(id, data) {
  const existing = await getTaskById(id);

  const newTaskText = data.task ?? existing.task;
  const newStatus = data.status ?? existing.status;
  const newAssignedTo = data.assigned_to || null;
  const newDueDate = data.due_date ?? existing.due_date;
  const newDescription =
    data.description !== undefined
      ? data.description
      : existing.description || "";
  const newPriority =
    data.priority !== undefined
      ? data.priority
      : existing.priority || "medium";

  const query = `
    UPDATE tasks
    SET task = $1,
        status = $2,
        assigned_to = $3,
        due_date = $4,
        description = $5,
        priority = $6,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $7
    RETURNING *;
  `;
  const values = [
    newTaskText,
    newStatus,
    newAssignedTo,
    newDueDate,
    newDescription,
    newPriority,
    id,
  ];

  const { rows } = await pool.query(query, values);
  if (rows.length === 0) {
    throw new Error("Task not found after update");
  }
  const updated = rows[0];

  const statusChanged = existing.status !== updated.status;
  const assigneeChanged =
    String(existing.assigned_to || "") !==
    String(updated.assigned_to || "");

  if (updated.assigned_to && (statusChanged || assigneeChanged)) {
    await notifyUser({
      user_id: updated.assigned_to,
      type: "task_updated",
      message: `Task "${updated.task}" was updated (status: ${updated.status})`,
      task_id: updated.id,
      project_id: updated.project_id,
    });
  }

  return updated;
}

/**
 * Update status as a normal user:
 * only allowed if the task is assigned_to that user
 */
export async function updateTaskStatusAsUser(id, userId, newStatus) {
  const existing = await getTaskById(id);

  if (existing.assigned_to !== userId) {
    throw new Error("You are not allowed to update this task");
  }

  const query = `
    UPDATE tasks
    SET status = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [newStatus, id]);
  if (rows.length === 0) {
    throw new Error("Task not found after update");
  }
  return rows[0];
}

/**
 * Delete task (admin/manager)
 */
export async function deleteTask(id) {
  const existing = await getTaskById(id);

  const { rowCount } = await pool.query(
    `DELETE FROM tasks WHERE id = $1`,
    [id]
  );
  if (rowCount === 0) {
    throw new Error("Task not found");
  }

  if (existing.assigned_to) {
    await notifyUser({
      user_id: existing.assigned_to,
      type: "task_deleted",
      message: `Task "${existing.task}" was deleted`,
      task_id: existing.id,
      project_id: existing.project_id,
    });
  }
}
