import express from "express";
import projectService from "../services/project.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";

const router = express.Router();

/**
 * 🔐 AUTH + WORKSPACE REQUIRED FOR ALL PROJECT ROUTES
 */
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

/**
 * CREATE PROJECT
 * admin / manager only
 */
router.post("/", allowRoles("admin", "manager"), async (req, res) => {
  try {
    req.body = req.body || {};

    // 🔐 enforce workspace from middleware (never from client)
    req.body.workspaceId = req.workspaceId;

    const project = await projectService.create(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * LIST PROJECTS (workspace scoped)
 */
router.get("/", async (req, res) => {
  try {
    const projects = await projectService.list(req.workspaceId);
    res.json(projects);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET SINGLE PROJECT
 */
router.get("/:id", async (req, res) => {
  try {
    const project = await projectService.getOne(
      req.params.id,
      req.workspaceId
    );

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(project);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * UPDATE PROJECT
 * admin / manager only
 */
router.put("/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    req.body = req.body || {};

    // 🔐 workspace enforced
    req.body.workspaceId = req.workspaceId;

    const updated = await projectService.update(
      req.params.id,
      req.body
    );

    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE PROJECT
 * admin only
 */
router.delete("/:id", allowRoles("admin"), async (req, res) => {
  try {
    await projectService.delete(req.params.id, req.workspaceId);
    res.json({ message: "Project deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
