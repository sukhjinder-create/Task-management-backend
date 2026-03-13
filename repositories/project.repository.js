import pool from "../db.js"; // ✅ correct path

class ProjectRepository {
  async createProject(data) {
    const query = `
      INSERT INTO projects (name, added_by, workspace_id)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;

    const values = [
      data.name,
      data.added_by,
      data.workspaceId || "GLOBAL",
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async getProjects(workspaceId = "GLOBAL") {
    const result = await pool.query(
      `
      SELECT *
      FROM projects
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      `,
      [workspaceId]
    );
    return result.rows;
  }

  /**
   * Role-scoped project list:
   *  admin   → all projects in workspace
   *  manager → projects in the user's `projects` array
   *  user    → projects where the user has at least one assigned task
   */
  async getProjectsByRole(workspaceId, userId, role) {
    if (role === "admin") {
      return this.getProjects(workspaceId);
    }

    if (role === "manager") {
      const result = await pool.query(
        `
        SELECT p.*
        FROM projects p
        INNER JOIN users u ON u.id = $2
        WHERE p.workspace_id = $1
          AND p.id = ANY(u.projects)
        ORDER BY p.created_at DESC
        `,
        [workspaceId, userId]
      );
      return result.rows;
    }

    // user role: only projects with at least one task assigned to this user
    const result = await pool.query(
      `
      SELECT DISTINCT p.*
      FROM projects p
      INNER JOIN tasks t ON t.project_id = p.id
      WHERE p.workspace_id = $1
        AND t.workspace_id = $1
        AND t.assigned_to = $2
      ORDER BY p.created_at DESC
      `,
      [workspaceId, userId]
    );
    return result.rows;
  }

  async getProjectById(id, workspaceId = "GLOBAL") {
    const result = await pool.query(
      `
      SELECT *
      FROM projects
      WHERE id = $1 AND workspace_id = $2
      `,
      [id, workspaceId]
    );
    return result.rows[0];
  }

  async updateProject(id, data) {
    const query = `
      UPDATE projects
      SET name = $1,
          updated_at = NOW()
      WHERE id = $2
        AND workspace_id = $3
      RETURNING *;
    `;

    const values = [
      data.name,
      id,
      data.workspaceId || "GLOBAL",
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

    async deleteProject(id, workspaceId = "GLOBAL") {

    // ----------------------------------------
    // 1️⃣ Delete project (tasks cascade delete)
    // ----------------------------------------
    await pool.query(
      `
      DELETE FROM projects
      WHERE id = $1 AND workspace_id = $2
      `,
      [id, workspaceId]
    );

    // ----------------------------------------
    // 2️⃣ CLEAN ORPHANED INTEGRATION MAPPINGS
    // ----------------------------------------
    await pool.query(
      `
      DELETE FROM integration_task_mappings m
      WHERE m.workspace_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM tasks t
          WHERE t.id = m.internal_task_id
        )
      `,
      [workspaceId]
    );

    return true;
  }
}

const projectRepository = new ProjectRepository();
export default projectRepository;