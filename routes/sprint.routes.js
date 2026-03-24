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
import { logAudit } from "../services/audit.service.js";

const router = express.Router({ mergeParams: true });

function historyMeta(projectId, extra = {}) {
  return {
    projectId,
    ...extra,
  };
}

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
      userRole: req.user.role,
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
    // Only admins can create hidden sprints
    const isHidden = req.user.role === "admin" ? (req.body.is_hidden === true) : false;
    const sprint = await createSprint({
      projectId: req.params.projectId,
      workspaceId: req.workspaceId,
      name: req.body.name,
      goal: req.body.goal,
      startDate: req.body.start_date,
      endDate: req.body.end_date,
      createdBy: req.user.id,
      isHidden,
    });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.sprint.created",
      entityType: "project",
      entityId: req.params.projectId,
      newValue: {
        sprint_id: sprint.id,
        name: sprint.name,
        goal: sprint.goal ?? null,
        status: sprint.status,
        start_date: sprint.start_date ?? null,
        end_date: sprint.end_date ?? null,
      },
      metadata: historyMeta(req.params.projectId, {
        sprintId: sprint.id,
        sprintName: sprint.name,
      }),
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
    // Only admins can toggle hidden flag
    const isHidden = req.user.role === "admin" && req.body.is_hidden !== undefined
      ? req.body.is_hidden
      : undefined;
    const beforeRes = await pool.query(
      `SELECT * FROM sprints WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    const before = beforeRes.rows[0];
    const sprint = await updateSprint({
      id: req.params.id,
      workspaceId: req.workspaceId,
      name: req.body.name,
      goal: req.body.goal,
      startDate: req.body.start_date,
      endDate: req.body.end_date,
      isHidden,
    });

    if (before) {
      await logAudit({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "project.history.sprint.updated",
        entityType: "project",
        entityId: sprint.project_id,
        oldValue: {
          sprint_id: before.id,
          name: before.name,
          goal: before.goal ?? null,
          status: before.status,
          start_date: before.start_date ?? null,
          end_date: before.end_date ?? null,
          is_hidden: before.is_hidden ?? false,
        },
        newValue: {
          sprint_id: sprint.id,
          name: sprint.name,
          goal: sprint.goal ?? null,
          status: sprint.status,
          start_date: sprint.start_date ?? null,
          end_date: sprint.end_date ?? null,
          is_hidden: sprint.is_hidden ?? false,
        },
        metadata: historyMeta(sprint.project_id, {
          sprintId: sprint.id,
          sprintName: sprint.name,
        }),
      });
    }

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
    const beforeRes = await pool.query(
      `SELECT * FROM sprints WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    const before = beforeRes.rows[0];
    await deleteSprint({ id: req.params.id, workspaceId: req.workspaceId });

    if (before) {
      await logAudit({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "project.history.sprint.deleted",
        entityType: "project",
        entityId: before.project_id,
        oldValue: {
          sprint_id: before.id,
          name: before.name,
          goal: before.goal ?? null,
          status: before.status,
        },
        metadata: historyMeta(before.project_id, {
          sprintId: before.id,
          sprintName: before.name,
        }),
      });
    }

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

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.sprint.started",
      entityType: "project",
      entityId: sprint.project_id,
      newValue: { sprint_id: sprint.id, status: sprint.status },
      metadata: historyMeta(sprint.project_id, {
        sprintId: sprint.id,
        sprintName: sprint.name,
      }),
    });

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

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.sprint.completed",
      entityType: "project",
      entityId: result.sprint?.project_id || result.project_id,
      newValue: {
        sprint_id: result.sprint?.id || req.params.id,
        status: result.sprint?.status || "completed",
      },
      metadata: historyMeta(result.sprint?.project_id || result.project_id, {
        sprintId: result.sprint?.id || req.params.id,
        sprintName: result.sprint?.name,
      }),
    });

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
    const taskRes = await pool.query(
      `SELECT id, project_id, sprint_id, task FROM tasks WHERE id = $1 AND workspace_id = $2`,
      [req.params.taskId, req.workspaceId]
    );
    const beforeTask = taskRes.rows[0];
    const result = await assignTaskToSprint({
      taskId: req.params.taskId,
      sprintId: req.body.sprint_id || null, // null = backlog
      workspaceId: req.workspaceId,
    });

    if (beforeTask) {
      await logAudit({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        action: "project.history.task.sprint_changed",
        entityType: "project",
        entityId: beforeTask.project_id,
        oldValue: { sprint_id: beforeTask.sprint_id || null },
        newValue: { sprint_id: req.body.sprint_id || null },
        metadata: historyMeta(beforeTask.project_id, {
          taskId: beforeTask.id,
          taskTitle: beforeTask.task,
        }),
      });
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   PATCH /sprints/:id/visibility
   Toggle is_hidden on a sprint (admin only)
------------------------------------------------------- */
router.patch("/sprints/:id/visibility", allowRoles("admin"), async (req, res) => {
  try {
    const { is_hidden } = req.body;
    if (typeof is_hidden !== "boolean") {
      return res.status(400).json({ error: "is_hidden must be a boolean" });
    }
    const { rows } = await pool.query(
      `UPDATE sprints SET is_hidden = $1, updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3 RETURNING *`,
      [is_hidden, req.params.id, req.workspaceId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Sprint not found" });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.sprint.visibility_changed",
      entityType: "project",
      entityId: rows[0].project_id,
      oldValue: { is_hidden: !is_hidden },
      newValue: { is_hidden },
      metadata: historyMeta(rows[0].project_id, {
        sprintId: rows[0].id,
        sprintName: rows[0].name,
      }),
    });

    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   GET /sprints
   List all sprints in the workspace (for reports filter / OKR linking)
   Admins see all sprints including hidden; others only see visible ones.
------------------------------------------------------- */
router.get("/sprints", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin" || req.user.role === "superadmin";
    const hiddenClause = isAdmin ? "" : "AND s.is_hidden = FALSE";
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.status, s.project_id, s.is_hidden,
              p.name AS project_name
       FROM sprints s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.workspace_id = $1
         ${hiddenClause}
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
