import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  createComment,
  getCommentsByTask,
} from "../services/comment.service.js";

const router = express.Router();

/**
 * 🔐 AUTH + WORKSPACE REQUIRED
 */
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

/**
 * GET /comments/:taskId
 * Get comments for a task (workspace isolated)
 */
router.get("/:taskId", async (req, res) => {
  try {
    const comments = await getCommentsByTask(
      req.params.taskId,
      req.workspaceId // 🔐 enforced
    );
    res.json(comments);
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

/**
 * POST /comments/:taskId
 * Frontend usage:
 * api.post(`/comments/${taskId}`, { comment_text })
 */
router.post("/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { comment_text } = req.body;

    if (!comment_text || !comment_text.trim()) {
      return res.status(400).json({ error: "comment_text is required" });
    }

    const comment = await createComment({
  task_id: taskId,
  comment_text,
  user: req.user,   // ✅ pass full user object
  workspaceId: req.workspaceId,
});

    res.status(201).json(comment);
  } catch (err) {
    console.error("Error creating comment:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /comments
 * Legacy / compatibility route
 * Body: { task_id, comment_text, added_by? }
 */
router.post("/", async (req, res) => {
  try {
    const { task_id, comment_text, added_by } = req.body;

    if (!task_id || !comment_text) {
      return res.status(400).json({
        error: "task_id and comment_text are required",
      });
    }

    const comment = await createComment({
      task_id,
      comment_text,
      user: req.user,
      workspaceId: req.workspaceId, // 🔐 enforced
    });

    res.status(201).json(comment);
  } catch (err) {
    console.error("Error creating comment (legacy):", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
