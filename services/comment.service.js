// services/comment.service.js
import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import { getTaskById } from "./task.service.js";
import { getUserByUsername } from "../repositories/user.repository.js";

export async function createComment({ task_id, comment_text, added_by }) {
  if (!task_id || !comment_text || !added_by) {
    throw new Error("task_id, comment_text and added_by are required");
  }

  const insertQuery = `
    INSERT INTO comments (task_id, comment_text, added_by)
    VALUES ($1, $2, $3)
    RETURNING *;
  `;
  const values = [task_id, comment_text, added_by];
  const { rows } = await pool.query(insertQuery, values);
  const comment = rows[0];

  try {
    const task = await getTaskById(task_id);

    // 🔔 Notify assignee (existing behaviour) + include comment_id
    if (task.assigned_to) {
      await notifyUser({
        user_id: task.assigned_to,
        type: "comment_added",
        message: `New comment on task "${task.task}" by ${added_by}`,
        task_id: task.id,
        project_id: task.project_id,
        comment_id: comment.id,
      });
    }

    // 🔔 NEW: @mentions → notify mentioned users
    // Matches @username, @user.name, @user_name, @user-name
    const mentionRegex = /@([a-zA-Z0-9_.-]+)/g;
    const mentionedUsernames = new Set();

    let match;
    while ((match = mentionRegex.exec(comment_text)) !== null) {
      if (match[1]) {
        mentionedUsernames.add(match[1]);
      }
    }

    for (const username of mentionedUsernames) {
      try {
        const mentionedUser = await getUserByUsername(username);
        if (!mentionedUser) continue;

        await notifyUser({
          user_id: mentionedUser.id,
          type: "comment_mention",
          message: `${added_by} mentioned you in a comment on task "${task.task}"`,
          task_id: task.id,
          project_id: task.project_id,
          comment_id: comment.id,
        });
      } catch (err) {
        console.error(
          "Failed to notify mentioned user:",
          username,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Failed to notify on comment:", err.message);
  }

  return comment;
}

export async function getCommentsByTask(taskId) {
  const query = `
    SELECT *
    FROM comments
    WHERE task_id = $1
    ORDER BY created_at DESC;
  `;
  const { rows } = await pool.query(query, [taskId]);
  return rows;
}
