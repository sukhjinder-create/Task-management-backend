import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { listSavedFilters, createSavedFilter, deleteSavedFilter } from "../services/savedFilters.service.js";

const router = express.Router();
router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// GET /saved-filters?project_id=
router.get("/", async (req, res) => {
  try {
    const filters = await listSavedFilters({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      projectId: req.query.project_id,
    });
    res.json(filters);
  } catch (err) {
res.status(400).json({ error: err.message });
  }
});

// POST /saved-filters
router.post("/", async (req, res) => {
  try {
    const filter = await createSavedFilter({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      projectId: req.body.project_id,
      name: req.body.name,
      filterConfig: req.body.filter_config,
      isShared: req.body.is_shared,
    });
    res.status(201).json(filter);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /saved-filters/:id
router.delete("/:id", async (req, res) => {
  try {
    await deleteSavedFilter({ id: req.params.id, userId: req.user.id, workspaceId: req.workspaceId });
    res.json({ message: "Filter deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
