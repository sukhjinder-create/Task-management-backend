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

export default router;
