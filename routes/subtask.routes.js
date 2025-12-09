import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  createSubtask,
  getSubtasks,
  updateSubtask,
  deleteSubtask,
} from "../services/task.service.js";

const router = express.Router();

// POST /subtasks
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { task_id, title, subtask, assigned_to, priority, status } = req.body;
    const finalTitle = title ?? subtask;

    if (!task_id || !finalTitle) {
      return res
        .status(400)
        .json({ error: "task_id and title are required" });
    }

    const created = await createSubtask({
      task_id,
      title: finalTitle,
      assigned_to: assigned_to || null,
      priority: priority || "medium",
      status: status || "pending",
      added_by: req.user.id,
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating subtask:", err);
    res.status(400).json({ error: err.message });
  }
});

// GET /subtasks/:taskId
router.get("/:taskId", authMiddleware, async (req, res) => {
  try {
    const subtasks = await getSubtasks(req.params.taskId);
    res.json(subtasks);
  } catch (err) {
    console.error("Error getting subtasks:", err);
    res.status(400).json({ error: err.message });
  }
});

// PUT /subtasks/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const updated = await updateSubtask(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error("Error updating subtask:", err);
    res.status(400).json({ error: err.message });
  }
});

// DELETE /subtasks/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    await deleteSubtask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting subtask:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
