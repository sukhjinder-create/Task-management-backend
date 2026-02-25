import express from "express";
import { migrateAsanaProject }
  from "./asana.migration.service.js";

const router = express.Router();

router.post(
  "/asana/projects/:projectId/migrate",
  async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      const userId = req.user.id;
      const { projectId } = req.params;

      const result = await migrateAsanaProject({
        workspaceId,
        projectId,
        triggeredBy: userId
      });

      res.json(result);

    } catch (err) {
      console.error("Migration failed:", err);
      res.status(500).json({
        error: "Migration failed"
      });
    }
  }
);

export default router;