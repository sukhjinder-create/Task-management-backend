import express from "express";
import projectService from "../services/project.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { getProjectHistory, logAudit } from "../services/audit.service.js";
import { getRequestAuditContext } from "../utils/requestContext.util.js";

const router = express.Router();

function projectSnapshot(project) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    project_code: project.project_code ?? null,
    added_by: project.added_by ?? null,
    workspace_id: project.workspace_id ?? null,
  };
}

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

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.create",
      entityType: "project",
      entityId: project.id,
      newValue: projectSnapshot(project),
      ...getRequestAuditContext(req, { projectId: project.id, projectName: project.name }),
    });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.project.created",
      entityType: "project",
      entityId: project.id,
      newValue: projectSnapshot(project),
      ...getRequestAuditContext(req, { projectId: project.id, projectName: project.name }),
    });

    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * LIST PROJECTS
 * admin   → all workspace projects
 * manager → only projects in their assigned projects array
 * user    → only projects where they have assigned tasks
 */
router.get("/", async (req, res) => {
  try {
    const projects = await projectService.list(
      req.workspaceId,
      req.user.role,
      req.user.id
    );
    res.json(projects);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id/history", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const project = await projectService.getOne(req.params.id, req.workspaceId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const result = await getProjectHistory({
      workspaceId: req.workspaceId,
      projectId: req.params.id,
      page: req.query.page,
      pageSize: req.query.pageSize,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    res.json(result);
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

    const existing = await projectService.getOne(req.params.id, req.workspaceId);
    if (!existing) {
      return res.status(404).json({ error: "Project not found" });
    }

    const updated = await projectService.update(
      req.params.id,
      req.body
    );

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.update",
      entityType: "project",
      entityId: updated.id,
      oldValue: projectSnapshot(existing),
      newValue: projectSnapshot(updated),
      ...getRequestAuditContext(req, { projectId: updated.id, projectName: updated.name }),
    });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.project.updated",
      entityType: "project",
      entityId: updated.id,
      oldValue: projectSnapshot(existing),
      newValue: projectSnapshot(updated),
      ...getRequestAuditContext(req, { projectId: updated.id, projectName: updated.name }),
    });

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
    const existing = await projectService.getOne(req.params.id, req.workspaceId);
    if (!existing) {
      return res.status(404).json({ error: "Project not found" });
    }

    await projectService.delete(req.params.id, req.workspaceId);

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.delete",
      entityType: "project",
      entityId: req.params.id,
      oldValue: projectSnapshot(existing),
      ...getRequestAuditContext(req, { projectId: req.params.id, projectName: existing.name }),
    });

    await logAudit({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      action: "project.history.project.deleted",
      entityType: "project",
      entityId: req.params.id,
      oldValue: projectSnapshot(existing),
      ...getRequestAuditContext(req, { projectId: req.params.id, projectName: existing.name }),
    });

    res.json({ message: "Project deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
