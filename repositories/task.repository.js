import pool from "../db.js";

class TaskRepository {
  async createTask(data) {
    // 🔒 Require workspace_id
    if (!data.workspaceId) {
      throw new Error("workspaceId is required for task creation");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Atomically increment the per-project ticket sequence
      let ticketNumber = null;
      if (data.project_id) {
        const seqRes = await client.query(
          `INSERT INTO project_ticket_sequences (project_id, last_number)
           VALUES ($1, 1)
           ON CONFLICT (project_id) DO UPDATE
             SET last_number = project_ticket_sequences.last_number + 1
           RETURNING last_number`,
          [data.project_id]
        );
        ticketNumber = seqRes.rows[0].last_number;
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
          workspace_id,
          ticket_number,
          story_points,
          task_type,
          is_blocked
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        ticketNumber,
        data.story_points || null,
        data.task_type || "task",
        data.is_blocked || false,
      ];

      const result = await client.query(query, values);
      await client.query("COMMIT");
      return result.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getTasksByProject(projectId, filters = {}, workspaceId) {
    // 🔒 Require workspace_id
    if (!workspaceId) {
      throw new Error("workspaceId is required for querying tasks");
    }

    let query = `
      SELECT t.*,
        CASE
          WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
          THEN p.project_code || '-' || t.ticket_number
          ELSE NULL
        END AS display_id
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = $1
        AND t.workspace_id = $2
    `;
    const values = [projectId, workspaceId];
    let idx = 3;

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

    if (filters.assigned_to) {
      query += ` AND t.assigned_to = $${idx}`;
      values.push(filters.assigned_to);
      idx++;
    }

    if (filters.overdue === true) {
      query += `
        AND t.due_date IS NOT NULL
        AND t.due_date < NOW()::date
        AND t.status != 'completed'
      `;
    }

    query += " ORDER BY t.created_at DESC";

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
        task         = $1,
        status       = $2,
        priority     = $3,
        assigned_to  = $4,
        due_date     = $5,
        description  = $6,
        story_points = $7,
        task_type    = $8,
        is_blocked   = $9,
        updated_at   = NOW()
      WHERE id = $10
        AND workspace_id = $11
      RETURNING *;
    `;

    const values = [
      data.task,
      data.status,
      data.priority || "medium",
      data.assigned_to || null,
      data.due_date || null,
      data.description || "",
      data.story_points != null ? parseInt(data.story_points) : null,
      data.task_type || "task",
      data.is_blocked || false,
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
