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
import { getWatchers } from "./watchers.service.js";
import { logAudit } from "./audit.service.js";

/**
 * Returns IDs of all workspace admins + managers assigned to this project.
 * Used to give supervisors real-time visibility on their team's task activity.
 */
async function getSupervisors(workspaceId, projectId) {
  try {
    const { rows } = await pool.query(
      `
      SELECT id FROM users
      WHERE workspace_id = $1
        AND (is_system IS NOT TRUE)
        AND (
          role = 'admin'
          OR (role = 'manager' AND $2 = ANY(projects))
        )
      `,
      [workspaceId, projectId]
    );
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

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

async function logProjectHistory({
  workspaceId,
  actorId,
  projectId,
  action,
  taskId = null,
  taskTitle = null,
  oldValue = null,
  newValue = null,
  metadata = {},
}) {
  await logAudit({
    workspaceId,
    userId: actorId,
    action,
    entityType: "project",
    entityId: projectId,
    oldValue,
    newValue,
    metadata: {
      projectId,
      taskId,
      taskTitle,
      ...metadata,
    },
  });
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
      COALESCE(st.completed_subtasks, 0) AS subtasks_completed,
      CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
           THEN p.project_code || '-' || t.ticket_number END AS display_id
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
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

  await logProjectHistory({
    workspaceId,
    actorId: added_by,
    projectId: created.project_id,
    action: "project.history.task.created",
    taskId: created.id,
    taskTitle: created.task,
    newValue: {
      task: created.task,
      status: created.status,
      priority: created.priority,
      assigned_to: created.assigned_to,
      due_date: created.due_date,
      sprint_id: created.sprint_id ?? null,
    },
  });

  try {
    const notified = new Set([added_by]);

    // Notify the assignee
    if (created.assigned_to && !notified.has(created.assigned_to)) {
      await notifyUser({
        user_id:    created.assigned_to,
        type:       "task_assigned",
        message:    `You have been assigned a new task: "${created.task}"`,
        task_id:    created.id,
        project_id: created.project_id,
        workspaceId,
      });
      notified.add(created.assigned_to);
    }

    // Notify project managers about the new task
    const { rows: managers } = await pool.query(
      `SELECT id FROM users
       WHERE workspace_id = $1
         AND role = 'manager'
         AND $2 = ANY(projects)
         AND (is_system IS NOT TRUE)`,
      [workspaceId, created.project_id]
    );
    for (const { id: mgId } of managers) {
      if (notified.has(mgId)) continue;
      await notifyUser({
        user_id:    mgId,
        type:       "task_assigned",
        message:    `New task created: "${created.task}"`,
        task_id:    created.id,
        project_id: created.project_id,
        workspaceId,
      });
      notified.add(mgId);
    }
  } catch (notifErr) {
    console.error("[notifications] createTask failed:", notifErr.message);
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
      COALESCE(st.completed_subtasks, 0) AS subtasks_completed,
      CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
           THEN p.project_code || '-' || t.ticket_number END AS display_id,
      sp.name AS sprint_name,
      sp.status AS sprint_status
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN sprints sp ON sp.id = t.sprint_id
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
  // sprint_id: undefined = don't change, null = move to backlog, uuid = assign to sprint
  const newSprintId =
    data.sprint_id !== undefined ? (data.sprint_id || null) : existing.sprint_id;
  const newTaskType =
    data.task_type !== undefined ? data.task_type : (existing.task_type || "task");
  const newStoryPoints =
    data.story_points !== undefined
      ? (data.story_points != null ? parseInt(data.story_points) : null)
      : existing.story_points ?? null;
  const newIsBlocked =
    data.is_blocked !== undefined ? Boolean(data.is_blocked) : (existing.is_blocked || false);

  // 🔹 1️⃣ Perform Update
  await pool.query(
    `
    UPDATE tasks
    SET task         = $1,
        status       = $2,
        assigned_to  = $3,
        due_date     = $4,
        description  = $5,
        priority     = $6,
        sprint_id    = $7,
        task_type    = $8,
        story_points = $9,
        is_blocked   = $10,
        updated_at   = CURRENT_TIMESTAMP
    WHERE id = $11
    `,
    [
      newTaskText,
      newStatus,
      newAssignedTo,
      newDueDate,
      newDescription,
      newPriority,
      newSprintId,
      newTaskType,
      newStoryPoints,
      newIsBlocked,
      id,
    ]
  );

  // 🔹 2️⃣ Fetch updated version
  const updatedTask = await getTaskById(id);


  // 🔹 3️⃣ LOG DIFFERENCES SAFELY

  const actorId = data.updated_by;

  if (existing.task !== updatedTask.task) {
    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.title_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { task: existing.task },
      newValue: { task: updatedTask.task },
    });
  }

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

    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.assignee_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { assigned_to: existing.assigned_to },
      newValue: { assigned_to: updatedTask.assigned_to },
    });
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

    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.status_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { status: existing.status },
      newValue: { status: updatedTask.status },
    });
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

    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.priority_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { priority: existing.priority },
      newValue: { priority: updatedTask.priority },
    });
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

    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.description_updated",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { description_length: existing.description?.length || 0 },
      newValue: { description_length: updatedTask.description?.length || 0 },
    });
  }

  if ((existing.due_date || null) !== (updatedTask.due_date || null)) {
    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.due_date_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { due_date: existing.due_date || null },
      newValue: { due_date: updatedTask.due_date || null },
    });
  }

  if ((existing.sprint_id || null) !== (updatedTask.sprint_id || null)) {
    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.sprint_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { sprint_id: existing.sprint_id || null },
      newValue: { sprint_id: updatedTask.sprint_id || null },
    });
  }

  if ((existing.task_type || "task") !== (updatedTask.task_type || "task")) {
    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.type_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { task_type: existing.task_type || "task" },
      newValue: { task_type: updatedTask.task_type || "task" },
    });
  }

  if ((existing.story_points ?? null) !== (updatedTask.story_points ?? null)) {
    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.story_points_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { story_points: existing.story_points ?? null },
      newValue: { story_points: updatedTask.story_points ?? null },
    });
  }

  if (Boolean(existing.is_blocked) !== Boolean(updatedTask.is_blocked)) {
    await logProjectHistory({
      workspaceId: data.workspaceId,
      actorId,
      projectId: updatedTask.project_id,
      action: "project.history.task.blocked_changed",
      taskId: updatedTask.id,
      taskTitle: updatedTask.task,
      oldValue: { is_blocked: Boolean(existing.is_blocked) },
      newValue: { is_blocked: Boolean(updatedTask.is_blocked) },
    });
  }

  // ─── NOTIFICATIONS ───────────────────────────────────────────────
  try {
    const actor    = data.updated_by || null;
    const wsId     = data.workspaceId;
    const taskName = updatedTask.task;

    // 1. Assignee changed
    if (existing.assigned_to !== updatedTask.assigned_to) {
      // Notify the new assignee
      if (updatedTask.assigned_to) {
        await notifyUser({
          user_id:    updatedTask.assigned_to,
          type:       "task_assigned",
          message:    `You have been assigned to task "${taskName}"`,
          task_id:    updatedTask.id,
          project_id: updatedTask.project_id,
          workspaceId: wsId,
        });
      }
      // Notify the old assignee they were unassigned
      if (existing.assigned_to && existing.assigned_to !== actor) {
        await notifyUser({
          user_id:    existing.assigned_to,
          type:       "task_updated",
          message:    `Task "${taskName}" has been reassigned`,
          task_id:    updatedTask.id,
          project_id: updatedTask.project_id,
          workspaceId: wsId,
        });
      }
    }

    // 2. Status changed — notify assignee (if not self-change)
    if (existing.status !== updatedTask.status && updatedTask.assigned_to && updatedTask.assigned_to !== actor) {
      await notifyUser({
        user_id:    updatedTask.assigned_to,
        type:       "task_updated",
        message:    `Task "${taskName}" status changed to "${updatedTask.status}"`,
        task_id:    updatedTask.id,
        project_id: updatedTask.project_id,
        workspaceId: wsId,
      });
    }

    // 3. Priority changed — notify assignee (if not self-change)
    if (existing.priority !== updatedTask.priority && updatedTask.assigned_to && updatedTask.assigned_to !== actor) {
      await notifyUser({
        user_id:    updatedTask.assigned_to,
        type:       "task_updated",
        message:    `Task "${taskName}" priority changed to "${updatedTask.priority}"`,
        task_id:    updatedTask.id,
        project_id: updatedTask.project_id,
        workspaceId: wsId,
      });
    }

    // 4. Due date changed — notify assignee (if not self-change)
    const oldDue = existing.due_date ? String(existing.due_date).slice(0, 10) : null;
    const newDue = updatedTask.due_date ? String(updatedTask.due_date).slice(0, 10) : null;
    if (oldDue !== newDue && updatedTask.assigned_to && updatedTask.assigned_to !== actor) {
      await notifyUser({
        user_id:    updatedTask.assigned_to,
        type:       "task_updated",
        message:    newDue
          ? `Due date for task "${taskName}" changed to ${newDue}`
          : `Due date removed from task "${taskName}"`,
        task_id:    updatedTask.id,
        project_id: updatedTask.project_id,
        workspaceId: wsId,
      });
    }

    // 5. Notify watchers on any meaningful change (except the actor)
    const hasChange =
      existing.status      !== updatedTask.status     ||
      existing.priority    !== updatedTask.priority   ||
      existing.assigned_to !== updatedTask.assigned_to ||
      oldDue               !== newDue;

    if (hasChange) {
      const watchers = await getWatchers({ taskId: updatedTask.id });
      for (const w of watchers) {
        if (w.user_id === actor || w.user_id === updatedTask.assigned_to) continue;
        await notifyUser({
          user_id:    w.user_id,
          type:       "task_updated",
          message:    `Task "${taskName}" was updated`,
          task_id:    updatedTask.id,
          project_id: updatedTask.project_id,
          workspaceId: wsId,
        });
      }
    }

    // 6. Notify admins + project managers when task status → completed
    if (existing.status !== updatedTask.status && updatedTask.status === "completed") {
      const supervisors = await getSupervisors(wsId, updatedTask.project_id);
      for (const supId of supervisors) {
        if (supId === actor) continue;
        await notifyUser({
          user_id:    supId,
          type:       "task_updated",
          message:    `Task "${taskName}" was marked as completed`,
          task_id:    updatedTask.id,
          project_id: updatedTask.project_id,
          workspaceId: wsId,
        });
      }
    }
  } catch (notifErr) {
    console.error("[notifications] updateTaskAsAdminOrManager failed:", notifErr.message);
  }
  // ─────────────────────────────────────────────────────────────────

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
  JSON.stringify({ status: existing.status }),
  JSON.stringify({ status: newStatus })
]);

  const updatedTask = await getTaskById(id);
  await logProjectHistory({
    workspaceId,
    actorId: userId,
    projectId: updatedTask.project_id,
    action: "project.history.task.status_changed",
    taskId: updatedTask.id,
    taskTitle: updatedTask.task,
    oldValue: { status: existing.status },
    newValue: { status: newStatus },
  });
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
  status: updatedTask.status,
  projectId: updatedTask.project_id,
  taskId: updatedTask.id,
});

// ─── NOTIFICATIONS ───────────────────────────────────────────────
try {
  // Notify watchers (not the user themselves)
  const watchers = await getWatchers({ taskId: updatedTask.id });
  for (const w of watchers) {
    if (w.user_id === userId) continue;
    await notifyUser({
      user_id:     w.user_id,
      type:        "task_updated",
      message:     `Task "${updatedTask.task}" status changed to "${newStatus}"`,
      task_id:     updatedTask.id,
      project_id:  updatedTask.project_id,
      workspaceId,
    });
  }

  // Notify admins + project managers when task is completed
  if (newStatus === "completed") {
    const supervisors = await getSupervisors(workspaceId, updatedTask.project_id);
    for (const supId of supervisors) {
      if (supId === userId) continue; // don't notify the person who completed it
      await notifyUser({
        user_id:    supId,
        type:       "task_updated",
        message:    `Task "${updatedTask.task}" was marked as completed`,
        task_id:    updatedTask.id,
        project_id: updatedTask.project_id,
        workspaceId,
      });
    }
  }
} catch (notifErr) {
  console.error("[notifications] updateTaskStatusAsUser failed:", notifErr.message);
}
// ─────────────────────────────────────────────────────────────────

return updatedTask;
}

/**
 * Delete task
 */
export async function deleteTask(id, workspaceId, actorId = null) {
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

  await logProjectHistory({
    workspaceId,
    actorId: actorId || existing.added_by,
    projectId: existing.project_id,
    action: "project.history.task.deleted",
    taskId: existing.id,
    taskTitle: existing.task,
    oldValue: {
      task: existing.task,
      status: existing.status,
      priority: existing.priority,
      assigned_to: existing.assigned_to,
      due_date: existing.due_date,
      sprint_id: existing.sprint_id ?? null,
    },
  });

  emitWorkspaceIntelligenceUpdate(workspaceId, {
    type: "task-deleted",
    projectId: existing.project_id,
    taskId: existing.id,
  });

  try {
    // Notify the assignee
    if (existing.assigned_to) {
      await notifyUser({
        user_id:    existing.assigned_to,
        type:       "task_deleted",
        message:    `Task "${existing.task}" was deleted`,
        task_id:    null, // already deleted — FK-safe
        project_id: existing.project_id,
        workspaceId,
      });
    }

    // Notify admins + project managers (skip if they are also the assignee)
    const supervisors = await getSupervisors(workspaceId, existing.project_id);
    for (const supId of supervisors) {
      if (supId === existing.assigned_to) continue;
      await notifyUser({
        user_id:    supId,
        type:       "task_deleted",
        message:    `Task "${existing.task}" was deleted`,
        task_id:    null,
        project_id: existing.project_id,
        workspaceId,
      });
    }
  } catch (notifErr) {
    console.error("[notifications] deleteTask failed:", notifErr.message);
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



