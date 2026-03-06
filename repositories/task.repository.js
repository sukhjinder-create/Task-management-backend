import pool from "../db.js";

class TaskRepository {
  async createTask(data) {
    // 🔒 Require workspace_id
    if (!data.workspaceId) {
      throw new Error("workspaceId is required for task creation");
    }

    const query = `
      INSERT INTO tasks (
        task,
        project_id,
        status,
        priority,
        added_by,
        assigned_to,
        due_date,
        description,
        workspace_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const values = [
      data.task,
      data.project_id,
      data.status || "pending",
      data.priority || "medium",
      data.added_by,
      data.assigned_to || null,
      data.due_date || null,
      data.description || "",
      data.workspaceId,
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async getTasksByProject(projectId, filters = {}, workspaceId) {
    // 🔒 Require workspace_id
    if (!workspaceId) {
      throw new Error("workspaceId is required for querying tasks");
    }

    let query = `
      SELECT *
      FROM tasks
      WHERE project_id = $1
        AND workspace_id = $2
    `;
    const values = [projectId, workspaceId];
    let idx = 3;

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

    if (filters.assigned_to) {
      query += ` AND assigned_to = $${idx}`;
      values.push(filters.assigned_to);
      idx++;
    }

    if (filters.overdue === true) {
      query += `
        AND due_date IS NOT NULL
        AND due_date < NOW()::date
        AND status != 'completed'
      `;
    }

    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, values);
    return result.rows;
  }

  async updateTask(id, data) {
    // 🔒 Require workspace_id
    if (!data.workspaceId) {
      throw new Error("workspaceId is required for task update");
    }

    const query = `
      UPDATE tasks
      SET
        task        = $1,
        status      = $2,
        priority    = $3,
        assigned_to = $4,
        due_date    = $5,
        description = $6,
        updated_at  = NOW()
      WHERE id = $7
        AND workspace_id = $8
      RETURNING *;
    `;

    const values = [
      data.task,
      data.status,
      data.priority || "medium",
      data.assigned_to || null,
      data.due_date || null,
      data.description || "",
      id,
      data.workspaceId,
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async deleteTask(id, workspaceId) {
    // 🔒 Require workspace_id
    if (!workspaceId) {
      throw new Error("workspaceId is required for task deletion");
    }

    await pool.query(
      `
      DELETE FROM tasks
      WHERE id = $1 AND workspace_id = $2
      `,
      [id, workspaceId]
    );
    return true;
  }
}

const taskRepository = new TaskRepository();
export default taskRepository;

// ───────────────────────────────────────────
// SUBTASKS REPOSITORY FUNCTIONS
// (INTENTIONALLY KEPT AS-IS + SAFE)
// ───────────────────────────────────────────

export async function createSubtaskRepo({
  task_id,
  title,
  status = "pending",
  assigned_to = null,
  priority = "medium",
  added_by = null,
}) {
  const query = `
    INSERT INTO subtasks (
      task_id,
      title,
      status,
      assigned_to,
      priority,
      added_by,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    RETURNING *;
  `;

  const values = [
    task_id,
    title,
    status,
    assigned_to,
    priority,
    added_by,
  ];

  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function getSubtasksRepo(taskId) {
  const { rows } = await pool.query(
    `
      SELECT s.*
      FROM subtasks s
      WHERE s.task_id = $1
      ORDER BY s.created_at ASC
    `,
    [taskId]
  );
  return rows;
}

export async function updateSubtaskRepo(id, data) {
  // load existing
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM subtasks WHERE id = $1`,
    [id]
  );
  if (existingRows.length === 0) {
    throw new Error("Subtask not found");
  }

  const existing = existingRows[0];

  const newTitle =
    data.title ?? data.subtask ?? existing.title;
  const newStatus = data.status ?? existing.status;
  const newAssignedTo =
    data.assigned_to !== undefined
      ? data.assigned_to
      : existing.assigned_to;
  const newPriority = data.priority ?? existing.priority ?? "medium";

  const query = `
    UPDATE subtasks
    SET
      title       = $1,
      status      = $2,
      assigned_to = $3,
      priority    = $4,
      updated_at  = NOW()
    WHERE id = $5
    RETURNING *;
  `;

  const values = [
    newTitle,
    newStatus,
    newAssignedTo,
    newPriority,
    id,
  ];

  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function deleteSubtaskRepo(id) {
  const { rows } = await pool.query(
    `DELETE FROM subtasks WHERE id = $1 RETURNING *;`,
    [id]
  );
  if (rows.length === 0) {
    throw new Error("Subtask not found");
  }
  return rows[0];
}
