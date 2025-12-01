// routes/comment.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  createComment,
  getCommentsByTask,
} from "../services/comment.service.js";

const router = express.Router();

// GET /comments/:taskId  -> comments for a task
router.get("/:taskId", authMiddleware, async (req, res) => {
  try {
    const comments = await getCommentsByTask(req.params.taskId);
    res.json(comments);
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

/**
 * POST /comments/:taskId
 * This matches the frontend: api.post(`/comments/${taskId}`, { comment_text })
 */
router.post("/:taskId", authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { comment_text } = req.body;

    if (!comment_text || !comment_text.trim()) {
      return res.status(400).json({ error: "comment_text is required" });
    }

    const comment = await createComment({
      task_id: taskId,
      comment_text,
      // we store the username as added_by if not explicitly provided
      added_by: req.user.username,
    });

    res.status(201).json(comment);
  } catch (err) {
    console.error("Error creating comment (POST /comments/:taskId):", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * Existing route: POST /comments
 * Kept for compatibility with any existing tools / Postman usage.
 * Body must include: { task_id, comment_text, added_by? }
 */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { task_id, comment_text, added_by } = req.body;
    const comment = await createComment({
      task_id,
      comment_text,
      added_by: added_by || req.user.username,
    });
    res.status(201).json(comment);
  } catch (err) {
    console.error("Error creating comment (POST /comments):", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
