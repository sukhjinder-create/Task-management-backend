import pool from "../db.js";      // ✅ new correct path

class CommentRepository {
  async addComment(data) {
    const query = `
      INSERT INTO comments (
        task_id,
        comment_text,
        added_by,
        workspace_id
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;

    const values = [
      data.task_id,
      data.comment_text,
      data.added_by,
      data.workspaceId || "GLOBAL",
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async getComments(taskId, workspaceId = "GLOBAL") {
    const result = await pool.query(
      `
      SELECT *
      FROM comments
      WHERE task_id = $1
        AND workspace_id = $2
      ORDER BY created_at DESC
      `,
      [taskId, workspaceId]
    );
    return result.rows;
  }
}

const commentRepository = new CommentRepository();
export default commentRepository;
