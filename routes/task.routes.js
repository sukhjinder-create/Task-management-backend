import pool from "../db.js";
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  createTask,
  getTasksByProjectForUser,
  updateTaskAsAdminOrManager,
  updateTaskStatusAsUser,
  deleteTask,
  getTaskById,
  createSubtask,
  getSubtasks,
  updateSubtask,
  deleteSubtask,
} from "../services/task.service.js";
import {
  createTasksFromNL,
  suggestNLCompletions,
  parseOnlyFromNL,
  getNLContext,
} from "../services/nlTaskCreation.service.js";

const router = express.Router();

/**
 * 🔐 AUTH + WORKSPACE REQUIRED
 */
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

function isValidUuid(value) {
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value);
}

/**
 * POST /tasks/nl/create
 * Natural language task creation (admin / manager only)
 */
router.post("/nl/create", async (req, res) => {
  try {
    if (req.user.role === "user") {
      return res
        .status(403)
        .json({ error: "Only admin/manager can create tasks" });
    }

    const {
      command,
      project_id,
      include_subtasks = true,
      auto_assign_by_workload = true,
      auto_set_dependencies = true,
    } = req.body || {};

    if (!command || String(command).trim().length < 6) {
      return res.status(400).json({
        error: "Command is required and must be descriptive",
      });
    }

    if (project_id && !isValidUuid(project_id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const result = await createTasksFromNL({
      command: String(command).trim(),
      workspaceId: req.workspaceId,
      userId: req.user.id,
      projectId: project_id || null,
      includeSubtasks: Boolean(include_subtasks),
      autoAssignByWorkload: Boolean(auto_assign_by_workload),
      autoSetDependencies: Boolean(auto_set_dependencies),
    });

    return res.status(201).json(result);
  } catch (err) {
    console.error("Error creating tasks from NL:", err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /tasks/nl/parse
 * Dry-run preview: parse command and return what would be created (no DB writes)
 */
router.post("/nl/parse", async (req, res) => {
  try {
    if (req.user.role === "user") {
      return res.status(403).json({ error: "Only admin/manager can preview task creation" });
    }

    const { command, project_id } = req.body || {};
    if (!command || String(command).trim().length < 6) {
      return res.status(400).json({ error: "Command is required and must be descriptive" });
    }

    if (project_id && !isValidUuid(project_id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const result = await parseOnlyFromNL({
      command: String(command).trim(),
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });

    if (project_id) {
      result.tasks = result.tasks.map(t => ({ ...t, project_id }));
    }

    return res.json(result);
  } catch (err) {
    console.error("Error parsing NL command:", err);
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /tasks/nl/context
 * Returns workspace projects and users for UI autocomplete / preview
 */
router.get("/nl/context", async (req, res) => {
  try {
    const context = await getNLContext(req.workspaceId);
    return res.json(context);
  } catch (err) {
    console.error("Error fetching NL context:", err);
    return res.status(500).json({ error: "Failed to fetch context" });
  }
});

/**
 * GET /tasks/nl/suggestions?q=...
 * Lightweight command suggestions for UX auto-complete
 */
router.get("/nl/suggestions", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);

    const suggestions = await suggestNLCompletions({
      partialCommand: q,
      workspaceId: req.workspaceId,
    });

    return res.json(suggestions);
  } catch (err) {
    console.error("Error fetching NL suggestions:", err);
    return res.status(500).json({ error: "Failed to fetch suggestions" });
  }
});

/**
 * GET /tasks/:projectId
 * - Admin/manager: all tasks in project
 * - User: only assigned tasks
 */
router.get("/:projectId", async (req, res) => {
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

    const tasks = await getTasksByProjectForUser(
      projectId,
      req.user,
      filters,
      req.workspaceId // 🔐 workspace enforced
    );

    res.json(tasks);
  } catch (err) {
    console.error("Error getting tasks:", err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

/**
 * POST /tasks/:projectId
 * Create task (admin / manager)
 */
router.post("/:projectId", async (req, res) => {
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
      priority,
    } = req.body;

    const created = await createTask({
      task,
      project_id,
      status,
      assigned_to,
      due_date,
      description,
      priority,
      added_by: req.user.id,
      workspaceId: req.workspaceId, // 🔐 enforced
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating task:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /tasks
 * Alternate create (legacy support)
 */
router.post("/", async (req, res) => {
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
      workspaceId: req.workspaceId, // 🔐 enforced
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating task:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /tasks/:id
 * - user: status only
 * - admin/manager: full update
 */
router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    if (req.user.role === "user") {
      const { status } = req.body;
      if (!status) {
        return res
          .status(400)
          .json({ error: "Status is required for user update" });
      }

      const updated = await updateTaskStatusAsUser(
  id,
  req.user.id,
  req.workspaceId,
  status
);

      return res.json(updated);
    }

    const updated = await updateTaskAsAdminOrManager(
  id,
  { 
    ...req.body, 
    workspaceId: req.workspaceId,
    updated_by: req.user.id
  }
);

    res.json(updated);
  } catch (err) {
    console.error("Error updating task:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /tasks/detail/:id
 */
router.get("/detail/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!isValidUuid(id)) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    const task = await getTaskById(id, req.workspaceId); // 🔐 enforced
    res.json(task);
  } catch (err) {
    console.error("Error fetching task:", err);
    res.status(404).json({ error: err.message });
  }
});

/**
 * DELETE /tasks/:id
 */
router.delete("/:id", async (req, res) => {
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

    await deleteTask(id, req.workspaceId); // 🔐 enforced
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

router.post("/:taskId/subtasks", async (req, res) => {
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
      workspaceId: req.workspaceId, // 🔐 enforced
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("Error creating subtask:", err);
    res.status(400).json({ error: err.message });
  }
});

router.get("/:taskId/subtasks", async (req, res) => {
  try {
    const list = await getSubtasks(
      req.params.taskId,
      req.workspaceId // 🔐 enforced
    );
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to load subtasks" });
  }
});

router.put("/subtasks/:id", async (req, res) => {
  try {
    const updated = await updateSubtask(
      req.params.id,
      { ...req.body, workspaceId: req.workspaceId } // 🔐 enforced
    );
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/subtasks/:id", async (req, res) => {
  try {
    await deleteSubtask(req.params.id, req.workspaceId); // 🔐 enforced
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id/logs", async (req, res) => {
  try {
    const taskId = req.params.id;

   const { rows } = await pool.query(`
  SELECT 
    l.*,
    actor.username AS actor_username,
    oldUser.username AS old_assignee_username,
    newUser.username AS new_assignee_username
  FROM task_activity_logs l
  LEFT JOIN users actor ON actor.id = l.actor_id
  LEFT JOIN users oldUser 
    ON oldUser.id::text = (l.old_value->>'assigned_to')
  LEFT JOIN users newUser 
    ON newUser.id::text = (l.new_value->>'assigned_to')
  WHERE l.task_id = $1
  ORDER BY l.created_at ASC
`, [taskId]);

    res.json(rows);

  } catch (err) {
    res.status(500).json({ error: "Failed to load logs" });
  }
});
