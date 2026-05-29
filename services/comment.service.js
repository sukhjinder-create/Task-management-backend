// services/comment.service.js
import pool from "../db.js";
import { notifyUser } from "./notification.service.js";
import { getTaskById } from "./task.service.js";
import { getUserByUsername } from "../repositories/user.repository.js";
import { logAudit } from "./audit.service.js";

export async function createComment({ task_id, comment_text, user, workspaceId }) {
  if (!task_id || !comment_text || !user?.id || !workspaceId) {
    throw new Error("task_id, comment_text and added_by are required");
  }

  const insertQuery = `
    INSERT INTO comments (task_id, comment_text, added_by)
    VALUES ($1, $2, $3)
    RETURNING *;
  `;
  const values = [task_id, comment_text, user.id];
  const { rows } = await pool.query(insertQuery, values);
  const comment = rows[0];
  const task = await getTaskById(task_id);

  await pool.query(`
    INSERT INTO task_activity_logs
    (task_id, workspace_id, actor_id, action_type, old_value, new_value)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [task_id, workspaceId, user.id, "COMMENT_ADDED", null, null]);

  await logAudit({
    workspaceId,
    userId: user.id,
    action: "project.history.comment.added",
    entityType: "project",
    entityId: task.project_id,
    newValue: {
      comment_id: comment.id,
      comment_preview: String(comment_text).slice(0, 160),
    },
    metadata: {
      projectId: task.project_id,
      taskId: task.id,
      taskTitle: task.task,
      commentId: comment.id,
      commentPreview: String(comment_text).slice(0, 160),
    },
  });

  try {
    // Track all IDs already notified so we never send duplicates
    const alreadyNotified = new Set([user.id]); // commenter never notifies themselves

    // ── 1. Assignee ──────────────────────────────────────────────
    if (task.assigned_to && !alreadyNotified.has(task.assigned_to)) {
      await notifyUser({
        user_id:    task.assigned_to,
        type:       "comment_added",
        message:    `${user.username} commented on task "${task.task}"`,
        task_id:    task.id,
        project_id: task.project_id,
        comment_id: comment.id,
        workspaceId,
      });
      alreadyNotified.add(task.assigned_to);
    }

    // ── 2. Task creator (added_by) ────────────────────────────────
    if (task.added_by && !alreadyNotified.has(task.added_by)) {
      await notifyUser({
        user_id:    task.added_by,
        type:       "comment_added",
        message:    `${user.username} commented on your task "${task.task}"`,
        task_id:    task.id,
        project_id: task.project_id,
        comment_id: comment.id,
        workspaceId,
      });
      alreadyNotified.add(task.added_by);
    }

    // ── 3. Previous commenters on this task ("conversation participants") ──
    const { rows: prevCommenters } = await pool.query(
      `SELECT DISTINCT added_by FROM comments
       WHERE task_id = $1 AND added_by != $2 AND id != $3`,
      [task_id, user.id, comment.id]
    );
    for (const { added_by } of prevCommenters) {
      if (alreadyNotified.has(added_by)) continue;
      await notifyUser({
        user_id:    added_by,
        type:       "comment_reply",
        message:    `${user.username} also commented on task "${task.task}"`,
        task_id:    task.id,
        project_id: task.project_id,
        comment_id: comment.id,
        workspaceId,
      });
      alreadyNotified.add(added_by);
    }

    // ── 4. Project managers assigned to this project ──────────────
    const { rows: managers } = await pool.query(
      `SELECT id FROM users
       WHERE workspace_id = $1
         AND role = 'manager'
         AND $2 = ANY(projects)
         AND (is_system IS NOT TRUE)`,
      [workspaceId, task.project_id]
    );
    for (const { id: mgId } of managers) {
      if (alreadyNotified.has(mgId)) continue;
      await notifyUser({
        user_id:    mgId,
        type:       "comment_added",
        message:    `${user.username} commented on task "${task.task}"`,
        task_id:    task.id,
        project_id: task.project_id,
        comment_id: comment.id,
        workspaceId,
      });
      alreadyNotified.add(mgId);
    }

    // ── 5. @mentions ──────────────────────────────────────────────
    const mentionRegex = /@([a-zA-Z0-9_.-]+)/g;
    const mentionedUsernames = new Set();
    let match;
    while ((match = mentionRegex.exec(comment_text)) !== null) {
      if (match[1]) mentionedUsernames.add(match[1]);
    }

    for (const username of mentionedUsernames) {
      try {
        const mentionedUser = await getUserByUsername(username, workspaceId);
        if (!mentionedUser) continue;
        if (alreadyNotified.has(mentionedUser.id)) continue;
        await notifyUser({
          user_id:    mentionedUser.id,
          type:       "comment_mention",
          message:    `${user.username} mentioned you in a comment on task "${task.task}"`,
          task_id:    task.id,
          project_id: task.project_id,
          comment_id: comment.id,
          workspaceId,
        });
        alreadyNotified.add(mentionedUser.id);
      } catch (err) {
        console.error("Failed to notify mentioned user:", username, err.message);
      }
    }
  } catch (err) {
    console.error("[notifications] createComment failed:", err.message);
  }

  return comment;
}

export async function getCommentsByTask(taskId) {
  const query = `
  SELECT
    c.*,
    u.username,
    u.email,
    u.avatar_url
  FROM comments c
  LEFT JOIN users u ON u.id = c.added_by
  WHERE c.task_id = $1
  ORDER BY c.created_at DESC;
`;
  const { rows } = await pool.query(query, [taskId]);
  return rows;
}
