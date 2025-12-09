// routes/task.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import {
  createTask,
  getTasksByProjectForUser,
  updateTaskAsAdminOrManager,
  updateTaskStatusAsUser,
  deleteTask,
  getTaskById,
} from "../services/task.service.js";

const router = express.Router();

function isValidUuid(value) {
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value);
}

/**
 * GET /tasks/:projectId
 * - For admin/manager: all tasks in the project (optionally filtered)
 * - For user: only tasks assigned to that user in that project
 *
 * Optional query params:
 *   ?status=pending|in-progress|completed
 *   ?priority=low|medium|high
 *   ?assigned_to=<userId>   (ignored for normal user, they always see only themselves)
 *   ?overdue=true           (due_date < today AND status != 'completed')
 */
router.get("/:projectId", authMiddleware, async (req, res) => {
  try {
    const projectId = req.params.projectId;

    if (!isValidUuid(projectId)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const filters = {
      status: req.query.status || undefined,
      priority: req.query.priority || undefined,
      assigned_to: req.query.assigned_to || undefined,
      overdue: req.query.overdue === "true",
    };

    const tasks = await getTasksByProjectForUser(projectId, req.user, filters);
    res.json(tasks);
  } catch (err) {
    console.error("Error getting tasks:", err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

/**
 * POST /tasks/:projectId
 * Used by frontend: api.post(`/tasks/${projectId}`, payload)
 * Creates a task for that project. Status defaults to "pending".
 * Optional fields: description, priority
 */
router.post("/:projectId", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "user") {
      return res
        .status(403)
        .json({ error: "Only admin/manager can create tasks" });
    }

    const project_id = req.params.projectId;
    if (!isValidUuid(project_id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const {
      task,
      status,
      assigned_to,
      due_date,
      description,
      priority, // optional
    } = req.body;

    const created = await createTask({
      task,
      project_id,
      status, // can be undefined; service will default to "pending"
      assigned_to,
      due_date,
      description,
      priority,
      added_by: req.user.id,
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating task:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * (Optional extra) POST /tasks
 * Supports alternative style: body contains { project_id, ... }
 */
router.post("/", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "user") {
      return res
        .status(403)
        .json({ error: "Only admin/manager can create tasks" });
    }

    const {
      project_id,
      task,
      status,
      assigned_to,
      due_date,
      description,
      priority,
    } = req.body;

    if (!isValidUuid(project_id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const created = await createTask({
      task,
      project_id,
      status,
      assigned_to,
      due_date,
      description,
      priority,
      added_by: req.user.id,
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating task (POST /tasks):", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /tasks/:id
 * - user: only change his own task status
 * - admin/manager: full task update (title, status, dates, assignee, description, priority)
 */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    // Normal user → only status via updateTaskStatusAsUser
    if (req.user.role === "user") {
      const { status } = req.body;
      if (!status) {
        return res
          .status(400)
          .json({ error: "Status is required for user update" });
      }

      const updated = await updateTaskStatusAsUser(id, req.user.id, status);
      return res.json(updated);
    }

    // Admin / manager → full update
    const updated = await updateTaskAsAdminOrManager(id, req.body);
    res.json(updated);
  } catch (err) {
    console.error("Error updating task:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /tasks/detail/:id
 * Get a single task (used for details panel if needed)
 */
router.get("/detail/:id", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }
    const task = await getTaskById(id);
    res.json(task);
  } catch (err) {
    console.error("Error fetching task:", err);
    res.status(404).json({ error: err.message });
  }
});

/**
 * DELETE /tasks/:id
 * Only admin / manager can delete
 */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    if (req.user.role === "user") {
      return res
        .status(403)
        .json({ error: "Only admin/manager can delete tasks" });
    }

    await deleteTask(id);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting task:", err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
/**
 * ===========================
 *       SUBTASK ROUTES
 * ===========================
 */

/**
 * POST /tasks/:taskId/subtasks
 * Create subtask under a task
 */
router.post("/:taskId/subtasks", authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { subtask, assigned_to, due_date, priority } = req.body;

    const created = await createSubtask({
      task_id: taskId,
      subtask,
      assigned_to,
      due_date,
      priority,
      added_by: req.user.id,
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating subtask:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /tasks/:taskId/subtasks
 */
router.get("/:taskId/subtasks", authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const list = await getSubtasks(taskId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to load subtasks" });
  }
});

/**
 * PUT /subtasks/:id
 */
router.put("/subtasks/:id", authMiddleware, async (req, res) => {
  try {
    const updated = await updateSubtask(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /subtasks/:id
 */
router.delete("/subtasks/:id", authMiddleware, async (req, res) => {
  try {
    await deleteSubtask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
