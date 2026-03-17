import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import {
  listTags, createTag, updateTag, deleteTag,
  getTaskTags, setTaskTags, addTaskTag, removeTaskTag,
} from "../services/tags.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /tags — list all workspace tags
router.get("/", async (req, res) => {
  try {
    const tags = await listTags({ workspaceId: req.workspaceId });
    res.json(tags);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /tags — create tag (admin/manager)
router.post("/", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const tag = await createTag({ workspaceId: req.workspaceId, name: req.body.name, color: req.body.color });
    res.status(201).json(tag);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /tags/:id
router.put("/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const tag = await updateTag({ id: req.params.id, workspaceId: req.workspaceId, name: req.body.name, color: req.body.color });
    res.json(tag);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /tags/:id
router.delete("/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    await deleteTag({ id: req.params.id, workspaceId: req.workspaceId });
    res.json({ message: "Tag deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /tags/tasks/:taskId — get tags for a task
router.get("/tasks/:taskId", async (req, res) => {
  try {
    const tags = await getTaskTags({ taskId: req.params.taskId });
    res.json(tags);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /tags/tasks/:taskId — replace all tags on a task
router.put("/tasks/:taskId", async (req, res) => {
  try {
    const tags = await setTaskTags({ taskId: req.params.taskId, tagIds: req.body.tag_ids || [], workspaceId: req.workspaceId });
    res.json(tags);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /tags/tasks/:taskId/:tagId — add single tag
router.post("/tasks/:taskId/:tagId", async (req, res) => {
  try {
    const tags = await addTaskTag({ taskId: req.params.taskId, tagId: req.params.tagId });
    res.json(tags);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /tags/tasks/:taskId/:tagId — remove single tag
router.delete("/tasks/:taskId/:tagId", async (req, res) => {
  try {
    const tags = await removeTaskTag({ taskId: req.params.taskId, tagId: req.params.tagId });
    res.json(tags);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
