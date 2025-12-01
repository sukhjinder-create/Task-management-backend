// routes/project.routes.js
import express from "express";
import projectService from "../services/project.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";

const router = express.Router();

// all project routes require auth
router.use(authMiddleware);

router.post("/", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const project = await projectService.create(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const projects = await projectService.list();
    res.json(projects);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const project = await projectService.getOne(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.put("/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const updated = await projectService.update(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", allowRoles("admin"), async (req, res) => {
  try {
    await projectService.delete(req.params.id);
    res.json({ message: "Project deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
