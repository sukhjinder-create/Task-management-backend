import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { getWatchers, isWatching, watchTask, unwatchTask } from "../services/watchers.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /watchers/:taskId
router.get("/:taskId", async (req, res) => {
  try {
    const [watchers, watching] = await Promise.all([
      getWatchers({ taskId: req.params.taskId }),
      isWatching({ taskId: req.params.taskId, userId: req.user.id }),
    ]);
    res.json({ watchers, watching });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /watchers/:taskId/watch
router.post("/:taskId/watch", async (req, res) => {
  try {
    const watchers = await watchTask({ taskId: req.params.taskId, userId: req.user.id, workspaceId: req.workspaceId });
    res.json({ watchers, watching: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /watchers/:taskId/watch
router.delete("/:taskId/watch", async (req, res) => {
  try {
    const watchers = await unwatchTask({ taskId: req.params.taskId, userId: req.user.id });
    res.json({ watchers, watching: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
