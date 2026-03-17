import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { toggleVote, getVotes, hasVoted } from "../services/votes.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /votes/:taskId
router.get("/:taskId", async (req, res) => {
  try {
    const [count, voted] = await Promise.all([
      getVotes({ taskId: req.params.taskId }),
      hasVoted({ taskId: req.params.taskId, userId: req.user.id }),
    ]);
    res.json({ count, voted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /votes/:taskId/toggle
router.post("/:taskId/toggle", async (req, res) => {
  try {
    const result = await toggleVote({ taskId: req.params.taskId, userId: req.user.id, workspaceId: req.workspaceId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
