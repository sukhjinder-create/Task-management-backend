import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  connectWorkspaceIntegration,
  getWorkspaceIntegrations,
  removeWorkspaceIntegration,
} from "../services/integration.service.js";
import asanaMigrationRoutes
  from "../integrations/asana/asana.migration.routes.js";
import youtrackMigrationRoutes
  from "../integrations/youtrack/youtrack.migration.routes.js";


const router = express.Router();

// 🔐 Workspace isolation (same pattern as other routes)
router.use(authMiddleware, requireWorkspaceForUser);

/**
 * Connect integration
 */
router.post("/connect/:provider", async (req, res) => {
  try {
    const { provider } = req.params;

    const result = await connectWorkspaceIntegration({
      workspaceId: req.workspaceId,
      provider,
    });

    res.json(result);
  } catch (err) {
    console.error("Integration connect failed:", err);
    res.status(500).json({ error: "Failed to connect integration" });
  }
});

/**
 * List integrations
 */
router.get("/", async (req, res) => {
  try {
    const data = await getWorkspaceIntegrations(req.workspaceId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

/**
 * Disconnect integration
 */
router.delete("/:provider", async (req, res) => {
  try {
    const { provider } = req.params;

    await removeWorkspaceIntegration(
      req.workspaceId,
      provider
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

router.use( asanaMigrationRoutes);
router.use(youtrackMigrationRoutes);

export default router;
