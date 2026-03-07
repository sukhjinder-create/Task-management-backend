import express from "express";
import { migrateYouTrackProject } from "./youtrack.migration.service.js";

const router = express.Router();

router.post("/youtrack/projects/:projectId/migrate", async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const userId = req.user.id;
    const { projectId } = req.params;

    const result = await migrateYouTrackProject({
      workspaceId,
      projectId,
      triggeredBy: userId,
    });

    res.json(result);
  } catch (err) {
    console.error("YouTrack migration failed:", err);
    res.status(500).json({ error: "Migration failed" });
  }
});

export default router;
