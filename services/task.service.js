// services/task.service.js
import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import {
  createSubtaskRepo,
  getSubtasksRepo,
  updateSubtaskRepo,
  deleteSubtaskRepo,
} from "../repositories/task.repository.js";

/**
 * NOTE: make sure you have this in DB:
 *
 * ALTER TABLE tasks
 *   ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
 */

// Get a single task by id (with subtask counts)
export async function getTaskById(id) {
  const { rows } = await pool.query(
    `
    SELECT
      t.*,
      COALESCE(st.total_subtasks, 0)     AS subtasks_total,
      COALESCE(st.completed_subtasks, 0) AS subtasks_completed
    FROM tasks t
    LEFT JOIN (
      SELECT
        task_id,
        COUNT(*) AS total_subtasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_subtasks
      FROM subtasks
      GROUP BY task_id
    ) st ON st.task_id = t.id
    WHERE t.id = $1
    `,
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

  // New task has 0 subtasks; front-end can treat missing counts as 0
  return {
    ...created,
    subtasks_total: 0,
    subtasks_completed: 0,
  };
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
    SELECT
      t.*,
      COALESCE(st.total_subtasks, 0)     AS subtasks_total,
      COALESCE(st.completed_subtasks, 0) AS subtasks_completed
    FROM tasks t
    LEFT JOIN (
      SELECT
        task_id,
        COUNT(*) AS total_subtasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_subtasks
      FROM subtasks
      GROUP BY task_id
    ) st ON st.task_id = t.id
    WHERE t.project_id = $1
  `;

  // Normal user → only tasks assigned to themselves
  if (user.role === "user") {
    query += ` AND t.assigned_to = $${idx}`;
    values.push(user.id);
    idx++;
  } else if (filters.assigned_to) {
    // Admin / manager can filter by assignee
    query += ` AND t.assigned_to = $${idx}`;
    values.push(filters.assigned_to);
    idx++;
  }

  if (filters.status) {
    query += ` AND t.status = $${idx}`;
    values.push(filters.status);
    idx++;
  }

  if (filters.priority) {
    query += ` AND t.priority = $${idx}`;
    values.push(filters.priority);
    idx++;
  }

  if (filters.overdue === true) {
    query += ` AND t.due_date IS NOT NULL 
               AND t.due_date < NOW()::date 
               AND t.status != 'completed'`;
  }

  query += ` ORDER BY t.created_at DESC`;

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

  // Return with subtask counts
  return await getTaskById(id);
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

  // Return with subtask counts
  return await getTaskById(id);
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

/**
 * Create subtask
 */
export async function createSubtask(data) {
  // Accept either .title or .subtask from frontend
  const title = data.title ?? data.subtask;

  if (!data.task_id || !title) {
    throw new Error("task_id and title are required");
  }

  const created = await createSubtaskRepo({
    task_id: data.task_id,
    title,
    status: data.status || "pending",
    assigned_to: data.assigned_to || null,
    priority: data.priority || "medium",
    added_by: data.added_by || null,
  });

  // also recompute parent progress after creating subtask
  await recomputeParentProgress(created.task_id);

  return created;
}

/**
 * Get all subtasks of task
 */
export async function getSubtasks(taskId) {
  return await getSubtasksRepo(taskId);
}

/**
 * Update subtask
 */
export async function updateSubtask(id, body) {
  const updated = await updateSubtaskRepo(id, body);

  // Auto recompute parent
  await recomputeParentProgress(updated.task_id);

  return updated;
}

/**
 * Delete subtask
 */
export async function deleteSubtask(id) {
  const deleted = await deleteSubtaskRepo(id);

  if (deleted && deleted.task_id) {
    await recomputeParentProgress(deleted.task_id);
  }

  return deleted;
}

/**
 * Auto-update parent task progress based on subtasks
 */
async function recomputeParentProgress(taskId) {
  const { rows } = await pool.query(
    `SELECT status FROM subtasks WHERE task_id = $1`,
    [taskId]
  );

  if (rows.length === 0) {
    // No subtasks → reset progress to 0 and don't force status
    await pool.query(
      `UPDATE tasks SET progress = 0, updated_at = now() WHERE id = $1`,
      [taskId]
    );
    return;
  }

  const total = rows.length;
  const completed = rows.filter((s) => s.status === "completed").length;
  const pct = Math.round((completed / total) * 100);

  let newParentStatus = "in-progress";
  if (pct === 0) newParentStatus = "pending";
  else if (pct === 100) newParentStatus = "completed";

  await pool.query(
    `UPDATE tasks SET progress = $1, status = $2, updated_at = now() WHERE id = $3`,
    [pct, newParentStatus, taskId]
  );
}
