import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  logTime, getTimeLogs, getTimeLogSummary,
  deleteTimeLog, updateEstimation, getProjectTimeReport,
} from "../services/timeTracking.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /time-tracking/tasks/:taskId
router.get("/tasks/:taskId", async (req, res) => {
  try {
    const [logs, summary] = await Promise.all([
      getTimeLogs({ taskId: req.params.taskId }),
      getTimeLogSummary({ taskId: req.params.taskId }),
    ]);
    res.json({ logs, summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /time-tracking/tasks/:taskId — log time
router.post("/tasks/:taskId", async (req, res) => {
  try {
    const log = await logTime({
      taskId: req.params.taskId,
      userId: req.user.id,
      workspaceId: req.workspaceId,
      hours: req.body.hours,
      logDate: req.body.log_date,
      description: req.body.description,
    });
    res.status(201).json(log);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /time-tracking/:logId
router.delete("/:logId", async (req, res) => {
  try {
    await deleteTimeLog({ id: req.params.logId, userId: req.user.id, workspaceId: req.workspaceId });
    res.json({ message: "Log deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /time-tracking/tasks/:taskId/estimation
router.patch("/tasks/:taskId/estimation", async (req, res) => {
  try {
    const result = await updateEstimation({
      taskId: req.params.taskId,
      workspaceId: req.workspaceId,
      estimationHours: req.body.estimation_hours,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /time-tracking/projects/:projectId/report
router.get("/projects/:projectId/report", async (req, res) => {
  try {
    const report = await getProjectTimeReport({ projectId: req.params.projectId, workspaceId: req.workspaceId });
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
