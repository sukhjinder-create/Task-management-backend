import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { listTemplates, createTemplate, updateTemplate, deleteTemplate } from "../services/issueTemplates.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /issue-templates?project_id=
router.get("/", async (req, res) => {
  try {
    const templates = await listTemplates({ workspaceId: req.workspaceId, projectId: req.query.project_id });
    res.json(templates);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /issue-templates
router.post("/", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const template = await createTemplate({
      workspaceId: req.workspaceId,
      projectId: req.body.project_id,
      name: req.body.name,
      description: req.body.description,
      defaultFields: req.body.default_fields,
      createdBy: req.user.id,
    });
    res.status(201).json(template);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /issue-templates/:id
router.put("/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const template = await updateTemplate({
      id: req.params.id,
      workspaceId: req.workspaceId,
      name: req.body.name,
      description: req.body.description,
      defaultFields: req.body.default_fields,
    });
    res.json(template);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /issue-templates/:id
router.delete("/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    await deleteTemplate({ id: req.params.id, workspaceId: req.workspaceId });
    res.json({ message: "Template deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
