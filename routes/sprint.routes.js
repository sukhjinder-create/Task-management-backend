import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import pool from "../db.js";
import {
  listSprints,
  createSprint,
  updateSprint,
  deleteSprint,
  startSprint,
  completeSprint,
  assignTaskToSprint,
} from "../services/sprint.service.js";

const router = express.Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireWorkspaceForUser);

/* -------------------------------------------------------
   GET /projects/:projectId/sprints
   List all sprints for a project
------------------------------------------------------- */
router.get("/projects/:projectId/sprints", async (req, res) => {
  try {
    const sprints = await listSprints({
      projectId: req.params.projectId,
      workspaceId: req.workspaceId,
    });
    res.json(sprints);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   POST /projects/:projectId/sprints
   Create sprint (admin / manager only)
------------------------------------------------------- */
router.post("/projects/:projectId/sprints", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const sprint = await createSprint({
      projectId: req.params.projectId,
      workspaceId: req.workspaceId,
      name: req.body.name,
      goal: req.body.goal,
      startDate: req.body.start_date,
      endDate: req.body.end_date,
      createdBy: req.user.id,
    });
    res.status(201).json(sprint);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   PUT /sprints/:id
   Update sprint name/goal/dates (admin / manager only)
------------------------------------------------------- */
router.put("/sprints/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const sprint = await updateSprint({
      id: req.params.id,
      workspaceId: req.workspaceId,
      name: req.body.name,
      goal: req.body.goal,
      startDate: req.body.start_date,
      endDate: req.body.end_date,
    });
    res.json(sprint);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   DELETE /sprints/:id
   Delete sprint — tasks moved to backlog (admin only)
------------------------------------------------------- */
router.delete("/sprints/:id", allowRoles("admin"), async (req, res) => {
  try {
    await deleteSprint({ id: req.params.id, workspaceId: req.workspaceId });
    res.json({ message: "Sprint deleted. Tasks moved to backlog." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   POST /sprints/:id/start
   Start a sprint (admin / manager only)
------------------------------------------------------- */
router.post("/sprints/:id/start", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const sprint = await startSprint({ id: req.params.id, workspaceId: req.workspaceId });
    res.json(sprint);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   POST /sprints/:id/complete
   Complete a sprint (admin / manager only)
------------------------------------------------------- */
router.post("/sprints/:id/complete", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const result = await completeSprint({ id: req.params.id, workspaceId: req.workspaceId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   PATCH /tasks/:taskId/sprint
   Assign task to sprint or move to backlog
------------------------------------------------------- */
router.patch("/tasks/:taskId/sprint", async (req, res) => {
  try {
    const result = await assignTaskToSprint({
      taskId: req.params.taskId,
      sprintId: req.body.sprint_id || null, // null = backlog
      workspaceId: req.workspaceId,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   GET /sprints
   List all sprints in the workspace (for reports filter)
------------------------------------------------------- */
router.get("/sprints", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.status, s.project_id,
              p.name AS project_name
       FROM sprints s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.workspace_id = $1
       ORDER BY p.name ASC, s.created_at DESC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   GET /sprints/:id/burndown
   Burndown chart data for a sprint
------------------------------------------------------- */
router.get("/sprints/:id/burndown", async (req, res) => {
  try {
    const { rows: sprint } = await pool.query(
      `SELECT * FROM sprints WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!sprint[0]) return res.status(404).json({ error: "Sprint not found" });

    const { rows: tasks } = await pool.query(
      `SELECT
         t.id, t.status, t.story_points,
         t.updated_at,
         (SELECT created_at FROM task_activity_logs
          WHERE task_id = t.id AND new_value = 'completed'
          ORDER BY created_at ASC LIMIT 1) AS completed_at
       FROM tasks t
       WHERE t.sprint_id = $1 AND t.workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );

    const totalPoints = tasks.reduce((s, t) => s + (t.story_points || 1), 0);
    const totalTasks  = tasks.length;

    // Build daily burndown from start_date to end_date (or today)
    const start = sprint[0].start_date ? new Date(sprint[0].start_date) : new Date();
    const end   = sprint[0].end_date   ? new Date(sprint[0].end_date)   : new Date();
    const today = new Date();
    const chartEnd = end < today ? end : today;

    const days = [];
    for (let d = new Date(start); d <= chartEnd; d.setDate(d.getDate() + 1)) {
      const dayStr = d.toISOString().slice(0, 10);
      const completedByDay = tasks.filter(t => t.completed_at && t.completed_at <= new Date(dayStr + "T23:59:59Z"));
      const burnedPoints = completedByDay.reduce((s, t) => s + (t.story_points || 1), 0);
      const burnedTasks  = completedByDay.length;
      days.push({
        date: dayStr,
        remaining_points: totalPoints - burnedPoints,
        remaining_tasks:  totalTasks  - burnedTasks,
        completed_points: burnedPoints,
        completed_tasks:  burnedTasks,
      });
    }

    // Ideal burndown line
    const dayCount = days.length;
    const ideal = days.map((d, i) => ({
      date: d.date,
      ideal_points: Math.round(totalPoints * (1 - i / Math.max(dayCount - 1, 1))),
      ideal_tasks:  Math.round(totalTasks  * (1 - i / Math.max(dayCount - 1, 1))),
    }));

    res.json({ sprint: sprint[0], days, ideal, totalPoints, totalTasks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   GET /sprints/:id/velocity
   Velocity chart: completed points per sprint in a project
------------------------------------------------------- */
router.get("/projects/:projectId/velocity", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         s.id, s.name, s.start_date, s.end_date, s.status,
         COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'completed'), 0)::int AS completed_points,
         COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
         COALESCE(SUM(t.story_points), 0)::int AS total_points,
         COUNT(t.id)::int AS total_tasks
       FROM sprints s
       LEFT JOIN tasks t ON t.sprint_id = s.id AND t.workspace_id = $2
       WHERE s.project_id = $1 AND s.workspace_id = $2
         AND s.status = 'completed'
       GROUP BY s.id
       ORDER BY s.end_date ASC NULLS LAST`,
      [req.params.projectId, req.workspaceId]
    );
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
