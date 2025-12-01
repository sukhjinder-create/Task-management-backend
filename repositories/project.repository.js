import pool from "../db.js";      // ✅ new correct path


class ProjectRepository {
  async createProject(data) {
    const query = `
      INSERT INTO projects (name, added_by)
      VALUES ($1, $2)
      RETURNING *;
    `;
    const values = [data.name, data.added_by];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async getProjects() {
    const result = await pool.query(
      "SELECT * FROM projects ORDER BY created_at DESC"
    );
    return result.rows;
  }

  async getProjectById(id) {
    const result = await pool.query("SELECT * FROM projects WHERE id = $1", [
      id
    ]);
    return result.rows[0];
  }

  async updateProject(id, data) {
    const query = `
      UPDATE projects
      SET name = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const result = await pool.query(query, [data.name, id]);
    return result.rows[0];
  }

  async deleteProject(id) {
    await pool.query("DELETE FROM projects WHERE id = $1", [id]);
    return true;
  }
}

const projectRepository = new ProjectRepository();
export default projectRepository;
