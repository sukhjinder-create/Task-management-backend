import pool from "../db.js"; // ✅ correct path

class ProjectRepository {
  /**
   * Generate a YouTrack-style project code from the project name.
   *
   * Multi-word  → initials of each word, up to 5 chars
   *   "Task Management" → "TM"
   *   "Backend API Service" → "BAS"
   *
   * Single word → first letter + consonants (strip vowels after first char), up to 5 chars
   *   "Adrian"   → "ADR"
   *   "Mobile"   → "MBL"
   *   "Frontend" → "FRNT"
   *   "Backend"  → "BCKN"
   */
  _generateCode(name) {
    const words = name.trim().replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);

    if (words.length > 1) {
      // Multi-word: take first letter of each word
      return words.slice(0, 5).map(w => w[0].toUpperCase()).join("");
    }

    // Single word: first letter + consonants from the rest, max 5 chars total
    const word = words[0].toUpperCase();
    const first = word[0];
    const rest = word.slice(1).replace(/[AEIOU]/g, ""); // strip vowels
    return (first + rest).slice(0, 5);
  }

  async createProject(data) {
    const workspaceId = data.workspaceId || "GLOBAL";

    // Auto-generate a unique project_code
    let baseCode = data.project_code?.trim().toUpperCase() || this._generateCode(data.name || "PROJ");
    let code = baseCode;
    let attempt = 1;

    while (true) {
      const { rows } = await pool.query(
        `SELECT 1 FROM projects WHERE project_code = $1 AND workspace_id = $2 LIMIT 1`,
        [code, workspaceId]
      );
      if (rows.length === 0) break;
      attempt++;
      code = `${baseCode}${attempt}`;
    }

    const query = `
      INSERT INTO projects (name, added_by, workspace_id, project_code)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;

    const values = [data.name, data.added_by, workspaceId, code];
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