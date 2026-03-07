// services/task.service.js
import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import {
  createSubtaskRepo,
  getSubtasksRepo,
  updateSubtaskRepo,
  deleteSubtaskRepo,
} from "../repositories/task.repository.js";
import projectRepository from "../repositories/project.repository.js";
import { emitWorkspaceIntelligenceUpdate } from "../realtime/socket.js";

/**
 * NOTE: make sure you have this in DB:
 *
 * ALTER TABLE tasks
 *   ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
 */

/* -------------------------------------------------------
   🔒 WORKSPACE SAFETY (ADD-ONLY)
------------------------------------------------------- */

async function assertProjectInWorkspace(projectId, workspaceId) {
  const project = await projectRepository.getProjectById(
    projectId,
    workspaceId
  );

  if (!project) {
    throw new Error("Project not found in this workspace");
  }

  return project;
}

/* -------------------------------------------------------
   TASK QUERIES
------------------------------------------------------- */

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
  workspaceId, // 🔹 REQUIRED
}) {
  if (!task || !project_id || !added_by) {
    throw new Error("task, project_id and added_by are required");
  }

  if (!workspaceId) {
    throw new Error("workspaceId is required for task creation");
  }

  // 🔒 workspace check
  await assertProjectInWorkspace(project_id, workspaceId);

  const assigned = assigned_to || null;

  let created;

try {
  await pool.query("BEGIN");

  // 1️⃣ Increment project ticket sequence safely
  const seqRes = await pool.query(
    `
    INSERT INTO project_ticket_sequences (project_id, last_number)
    VALUES ($1, 1)
    ON CONFLICT (project_id)
    DO UPDATE SET last_number = project_ticket_sequences.last_number + 1
    RETURNING last_number
    `,
    [project_id]
  );

  const ticketNumber = seqRes.rows[0].last_number;

  // 2️⃣ Insert task with ticket_number and workspace_id
  const insertRes = await pool.query(
    `
    INSERT INTO tasks
    (task, project_id, status, priority, added_by, assigned_to, due_date, description, ticket_number, workspace_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *;
    `,
    [
      task,
      project_id,
      status,
      priority || "medium",
      added_by,
      assigned,
      due_date,
      description || "",
      ticketNumber,
      workspaceId  // ✅ NOW INCLUDED
    ]
  );

  created = insertRes.rows[0];

  // 📝 Log: Task Created
await pool.query(`
  INSERT INTO task_activity_logs
  (task_id, workspace_id, actor_id, action_type, old_value, new_value)
  VALUES ($1,$2,$3,$4,$5,$6)
`, [
  created.id,
  workspaceId,
  added_by,
  "TASK_CREATED",
  null,
  JSON.stringify({
    task: created.task,
    status: created.status,
    priority: created.priority,
    assigned_to: created.assigned_to
  })
]);

  // Optional: prepend project code visually (does not affect numbering)
const projectRes = await pool.query(
  `SELECT project_code FROM projects WHERE id = $1`,
  [project_id]
);

if (projectRes.rows[0]?.project_code) {
  created.display_id = `${projectRes.rows[0].project_code}-${created.ticket_number}`;
}

  await pool.query("COMMIT");

} catch (err) {
  await pool.query("ROLLBACK");
  throw err;
}
  // 🧠 workspace intelligence update
emitWorkspaceIntelligenceUpdate(workspaceId, {
  type: "task-created",
  projectId: created.project_id,
  taskId: created.id,
});

  if (created.assigned_to) {
    await notifyUser({
      user_id: created.assigned_to,
      type: "task_assigned",
      message: `You have been assigned a new task: "${created.task}"`,
      task_id: created.id,
      project_id: created.project_id,
    });
  }

  return {
    ...created,
    subtasks_total: 0,
    subtasks_completed: 0,
  };
}

/**
 * Get tasks for a project
 */
export async function getTasksByProjectForUser(projectId, user, filters = {}) {
  // 🔒 workspace check
  await assertProjectInWorkspace(projectId, user.workspaceId);

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

  if (user.role === "user") {
    query += ` AND t.assigned_to = $${idx}`;
    values.push(user.id);
    idx++;
  } else if (filters.assigned_to) {
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
 * Update a task as admin/manager
 */
export async function updateTaskAsAdminOrManager(id, data) {
  const existing = await getTaskById(id);

  await assertProjectInWorkspace(existing.project_id, data.workspaceId);

  const newTaskText = data.task ?? existing.task;
  const newStatus = data.status ?? existing.status;
  const newAssignedTo = data.assigned_to ?? existing.assigned_to ?? null;
  const newDueDate = data.due_date ?? existing.due_date;
  const newDescription =
    data.description !== undefined
      ? data.description
      : existing.description || "";
  const newPriority =
    data.priority !== undefined
      ? data.priority
      : existing.priority || "medium";

  // 🔹 1️⃣ Perform Update
  await pool.query(
    `
    UPDATE tasks
    SET task = $1,
        status = $2,
        assigned_to = $3,
        due_date = $4,
        description = $5,
        priority = $6,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $7
    `,
    [
      newTaskText,
      newStatus,
      newAssignedTo,
      newDueDate,
      newDescription,
      newPriority,
      id,
    ]
  );

  // 🔹 2️⃣ Fetch updated version
  const updatedTask = await getTaskById(id);

  // 🔹 3️⃣ LOG DIFFERENCES SAFELY

  const actorId = data.updated_by;

  // ASSIGNEE CHANGE
  if (existing.assigned_to !== updatedTask.assigned_to) {
    await pool.query(`
      INSERT INTO task_activity_logs
      (task_id, workspace_id, actor_id, action_type, old_value, new_value)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      id,
      data.workspaceId,
      actorId,
      "ASSIGNEE_CHANGED",
      JSON.stringify({ assigned_to: existing.assigned_to }),
      JSON.stringify({ assigned_to: updatedTask.assigned_to })
    ]);
  }

  // STATUS CHANGE
  if (existing.status !== updatedTask.status) {
    await pool.query(`
      INSERT INTO task_activity_logs
      (task_id, workspace_id, actor_id, action_type, old_value, new_value)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      id,
      data.workspaceId,
      actorId,
      "STATUS_CHANGED",
      JSON.stringify({ status: existing.status }),
      JSON.stringify({ status: updatedTask.status })
    ]);
  }

  // PRIORITY CHANGE
  if (existing.priority !== updatedTask.priority) {
    await pool.query(`
      INSERT INTO task_activity_logs
      (task_id, workspace_id, actor_id, action_type, old_value, new_value)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      id,
      data.workspaceId,
      actorId,
      "PRIORITY_CHANGED",
      JSON.stringify({ priority: existing.priority }),
      JSON.stringify({ priority: updatedTask.priority })
    ]);
  }

  // DESCRIPTION CHANGE
  if (existing.description !== updatedTask.description) {
    await pool.query(`
      INSERT INTO task_activity_logs
      (task_id, workspace_id, actor_id, action_type, old_value, new_value)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      id,
      data.workspaceId,
      actorId,
      "DESCRIPTION_UPDATED",
      null,
      null
    ]);
  }

  return updatedTask;
}

/**
 * Update status as a normal user
 */
export async function updateTaskStatusAsUser(
  id,
  userId,
  workspaceId,
  newStatus
) {
  const existing = await getTaskById(id);

  if (!existing) {
    throw new Error("Task not found");
  }

  // 🔒 Workspace validation
  await assertProjectInWorkspace(existing.project_id, workspaceId);

  // 🔒 Ownership validation
  if (existing.assigned_to !== userId) {
    throw new Error("You are not allowed to update this task");
  }

  // 🛑 Prevent unnecessary update
  if (existing.status === newStatus) {
    return existing;
  }

  if (newStatus === "completed") {
    // ✅ Set completed_at only if not already set
    await pool.query(
      `
      UPDATE tasks
      SET status = $1,
          updated_at = CURRENT_TIMESTAMP,
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
      WHERE id = $2
      `,
      [newStatus, id]
    );
  } else {
    // 🔁 Reopened or moved to other status
    await pool.query(
      `
      UPDATE tasks
      SET status = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [newStatus, id]
    );
  }

  // 📝 Log: Status Changed
await pool.query(`
  INSERT INTO task_activity_logs
  (task_id, workspace_id, actor_id, action_type, old_value, new_value)
  VALUES ($1,$2,$3,$4,$5,$6)
`, [
  id,
  workspaceId,
  userId,
  "STATUS_CHANGED",
  existing.status,
  newStatus
]);

  const updatedTask = await getTaskById(id);
  // 🧠 trigger intelligence recalculation (async, non-blocking)
import("../intelligence/manualScoring.service.js")
  .then(({ runManualMonthlyScoring }) => {
    const month = new Date().toISOString().slice(0, 7);

    runManualMonthlyScoring({
      workspaceId,
      month,
      triggeredBy: userId || updatedTask.added_by,
    }).catch(() => {});
  })
  .catch(() => {});

emitWorkspaceIntelligenceUpdate(workspaceId, {
  type: "task-status-changed",
  status: updatedTask.status, // ⭐ REQUIRED
  projectId: updatedTask.project_id,
  taskId: updatedTask.id,
});

return updatedTask;
}

/**
 * Delete task
 */
export async function deleteTask(id, workspaceId) {
  const existing = await getTaskById(id);

  // 🔒 workspace check
  await assertProjectInWorkspace(existing.project_id, workspaceId);

  // 📝 Log: Task Deleted
await pool.query(`
  INSERT INTO task_activity_logs
  (task_id, workspace_id, actor_id, action_type, old_value, new_value)
  VALUES ($1,$2,$3,$4,$5,$6)
`, [
  existing.id,
  workspaceId,
  existing.added_by,
  "TASK_DELETED",
  JSON.stringify(existing),
  null
]);

  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);

  if (existing.assigned_to) {
    await notifyUser({
      user_id: existing.assigned_to,
      type: "task_deleted",
      message: `Task "${existing.task}" was deleted`,
      // Task row is already deleted, so keep notification FK-safe.
      task_id: null,
      project_id: existing.project_id,
    });
    emitWorkspaceIntelligenceUpdate(workspaceId, {
  type: "task-deleted",
  projectId: existing.project_id,
  taskId: existing.id,
});
  }
}

/* -------------------------------------------------------
   SUBTASKS (INHERIT SAFETY VIA PARENT TASK)
------------------------------------------------------- */

export async function createSubtask(data) {
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

  await recomputeParentProgress(created.task_id);
  return created;
}

export async function getSubtasks(taskId) {
  return await getSubtasksRepo(taskId);
}

export async function updateSubtask(id, body) {
  const updated = await updateSubtaskRepo(id, body);
  await recomputeParentProgress(updated.task_id);
  return updated;
}

export async function deleteSubtask(id) {
  const deleted = await deleteSubtaskRepo(id);
  if (deleted?.task_id) {
    await recomputeParentProgress(deleted.task_id);
  }
  return deleted;
}

/**
 * Auto-update parent task progress
 */
async function recomputeParentProgress(taskId) {
  const { rows } = await pool.query(
    `SELECT status FROM subtasks WHERE task_id = $1`,
    [taskId]
  );

  if (rows.length === 0) {
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
