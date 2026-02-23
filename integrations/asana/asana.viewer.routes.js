import express from "express";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../../middleware/workspace.middleware.js";

import {
  fetchAsanaProjects,
  fetchAsanaProjectTasks,
} from "./asana.viewer.service.js";

const router = express.Router();

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
    const tasks = await fetchAsanaProjectTasks(
      req.workspaceId,
      req.params.projectId
    );

    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

export default router;
