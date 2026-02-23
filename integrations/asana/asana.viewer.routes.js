import express from "express";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../../middleware/workspace.middleware.js";
import {
  fetchAsanaProjects,
  fetchAsanaProjectTasks,
  updateAsanaTaskStatus,
} from "./asana.viewer.service.js";

const router = express.Router();

// ✅ Allow PATCH preflight for Asana routes
router.options("*", (req, res) => {
  res.sendStatus(204);
});

router.use(authMiddleware, requireWorkspaceForUser);

/**
 * GET projects
 */
router.get("/projects", async (req, res) => {
  try {
    const projects = await fetchAsanaProjects(
      req.workspaceId
    );

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

/**
 * GET project tasks
 */
router.get("/projects/:projectId/tasks", async (req, res) => {
  try {
    const { page, limit, search } = req.query;

    const result = await fetchAsanaProjectTasks(
      req.workspaceId,
      req.params.projectId,
      {
        page: Number(page) || 1,
        limit: Number(limit) || 25,
        search: search || "",
      }
    );

    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

/**
 * PATCH update task status (Mark Done)
 */
router.patch("/tasks/:taskId/status", async (req, res) => {
    console.log("🔥 PATCH HIT", req.params.taskId, req.body);
  try {
    const { taskId } = req.params;
    const { completed } = req.body;

    if (typeof completed !== "boolean") {
      return res.status(400).json({
        error: "completed must be boolean",
      });
    }

    const result = await updateAsanaTaskStatus(
      req.workspaceId,
      taskId,
      completed
    );

    res.json(result);
  } catch (err) {
    console.error("Asana status update failed:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to update task status" });
  }
});

export default router;
