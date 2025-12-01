import pool from "../db.js";      // ✅ new correct path


class CommentRepository {
  async addComment(data) {
    const query = `
      INSERT INTO comments (task_id, comment_text, added_by)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const values = [data.task_id, data.comment_text, data.added_by];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async getComments(taskId) {
    const result = await pool.query(
      "SELECT * FROM comments WHERE task_id = $1 ORDER BY created_at DESC",
      [taskId]
    );
    return result.rows;
  }
}

const commentRepository = new CommentRepository();
export default commentRepository;
