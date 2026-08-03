import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
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
import customProviderRoutes from "../integrations/custom/customProvider.routes.js";
import pool from "../db.js";
import {
  listBuiltInProviders,
  describeCustomProvider,
} from "../integrations/core/providerCapabilities.js";
import {
  listSyncConfigs,
  upsertSyncConfig,
} from "../integrations/sync/integration.syncConfig.repository.js";
import { syncIntegrationNow } from "../integrations/sync/integration.sync.manager.js";


const router = express.Router();

// 🔐 Workspace isolation (same pattern as other routes)
router.use(authMiddleware, requireWorkspaceForUser);
router.use(allowRoles("admin"));
router.use(express.json({ limit: "50mb" }));
router.use(express.urlencoded({ extended: true, limit: "50mb" }));

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
 * Available providers (built-in + this workspace's custom ones), with the
 * capability metadata the UI needs to render itself instead of hardcoding a
 * panel per platform.
 *
 * Declared before the "/:provider" routes below so it isn't shadowed by them.
 */
router.get("/providers", async (req, res) => {
  try {
    const builtIn = listBuiltInProviders();
    const { rows } = await pool.query(
      `SELECT * FROM custom_integration_providers
       WHERE workspace_id = $1 AND status <> 'disabled'
       ORDER BY name`,
      [req.workspaceId]
    );
    res.json({ providers: [...builtIn, ...rows.map(describeCustomProvider)] });
  } catch (err) {
    console.error("Failed to list providers:", err);
    res.status(500).json({ error: "Failed to list providers" });
  }
});

/**
 * Sync configuration — how often each integration is reconciled and which
 * external projects are in scope.
 */
router.get("/sync-config", async (req, res) => {
  try {
    res.json({ configs: await listSyncConfigs(req.workspaceId) });
  } catch (err) {
    console.error("Failed to load sync config:", err);
    res.status(500).json({ error: "Failed to load sync configuration" });
  }
});

router.put("/sync-config/:provider", async (req, res) => {
  try {
    const config = await upsertSyncConfig({
      workspaceId: req.workspaceId,
      provider: req.params.provider,
      patch: {
        syncMode: req.body?.syncMode,
        reconcileIntervalMinutes: req.body?.reconcileIntervalMinutes,
        scopedProjectIds: req.body?.scopedProjectIds,
      },
    });
    res.json({ config });
  } catch (err) {
    // Validation failures (bad mode, out-of-range interval) are the caller's
    // fault, not a server error.
    res.status(400).json({ error: err.message });
  }
});

/**
 * Force a sync immediately, without waiting for the next reconciliation.
 */
router.post("/sync-now/:provider", async (req, res) => {
  try {
    const result = await syncIntegrationNow({
      workspaceId: req.workspaceId,
      provider: req.params.provider,
      reason: "manual",
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-defined platforms. Mounted before "/:provider" so its paths win.
router.use(customProviderRoutes);

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
