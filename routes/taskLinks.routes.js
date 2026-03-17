import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { getTaskLinks, addTaskLink, removeTaskLink, searchTasksForLinking } from "../services/taskLinks.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /task-links/:taskId
router.get("/:taskId", async (req, res) => {
  try {
    const links = await getTaskLinks({ taskId: req.params.taskId });
    res.json(links);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /task-links — add a link
router.post("/", async (req, res) => {
  try {
    const links = await addTaskLink({
      sourceTaskId: req.body.source_task_id,
      targetTaskId: req.body.target_task_id,
      linkType: req.body.link_type,
      workspaceId: req.workspaceId,
      createdBy: req.user.id,
    });
    res.status(201).json(links);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /task-links/:linkId
router.delete("/:linkId", async (req, res) => {
  try {
    await removeTaskLink({ linkId: req.params.linkId, workspaceId: req.workspaceId });
    res.json({ message: "Link removed" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /task-links/search?q=&exclude=
router.get("/search/tasks", async (req, res) => {
  try {
    const tasks = await searchTasksForLinking({
      workspaceId: req.workspaceId,
      query: req.query.q || "",
      excludeTaskId: req.query.exclude || "00000000-0000-0000-0000-000000000000",
    });
    res.json(tasks);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
