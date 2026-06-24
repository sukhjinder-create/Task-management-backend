import express from "express";
import { getIntegrationAdapter } from "./integration.adapter.js";

const router = express.Router();

/**
 * List projects (universal)
 */
router.get("/:provider/projects", async (req, res) => {
  try {
    const { provider } = req.params;
    const workspaceId = req.workspaceId;

    const adapter = await getIntegrationAdapter(provider);

    const projects = await adapter.listProjects(workspaceId);

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Migrate project (universal)
 */
router.post("/:provider/projects/:projectId/migrate", async (req, res) => {
  try {
    const { provider, projectId } = req.params;

    const adapter = await getIntegrationAdapter(provider);

    const result = await adapter.migrateProject({
      workspaceId: req.workspaceId,
      projectId,
      triggeredBy: req.user.id,
      mode: req.body?.mode || "skip",
      projectWebhookId: req.body?.projectWebhookId || null,
    });

    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
