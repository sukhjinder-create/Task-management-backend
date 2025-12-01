import pool from "../db.js";

class TaskRepository {
  async createTask(data) {
    const query = `
      INSERT INTO tasks (task, project_id, status, priority, added_by, assigned_to, due_date, description)
      VALUES ($1,   $2,         $3,     $4,       $5,       $6,          $7,      $8)
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
    ];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async getTasksByProject(projectId, filters = {}) {
    let query = `
      SELECT *
      FROM tasks
      WHERE project_id = $1
    `;
    const values = [projectId];
    let idx = 2;

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
      query +=
        " AND due_date IS NOT NULL AND due_date < NOW()::date AND status != 'completed'";
    }

    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, values);
    return result.rows;
  }

  async updateTask(id, data) {
    const query = `
      UPDATE tasks
      SET task = $1,
          status = $2,
          priority = $3,
          assigned_to = $4,
          due_date = $5,
          description = $6,
          updated_at = NOW()
      WHERE id = $7
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
    ];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async deleteTask(id) {
    await pool.query("DELETE FROM tasks WHERE id = $1", [id]);
    return true;
  }
}

const taskRepository = new TaskRepository();
export default taskRepository;
