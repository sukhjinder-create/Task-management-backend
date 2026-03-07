// routes/autopilot.routes.js
import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { allowRoles } from "../middleware/role.middleware.js";
import {
  getAutopilotSettings,
  createOrUpdateAutopilotSettings,
  getPendingActions,
  getActionById,
  approveAction,
  rejectAction,
  runAutopilot,
  getAutopilotStats,
  getAutopilotHistory,
} from "../services/autopilot.service.js";

const router = express.Router();

router.use(authMiddleware);
router.use(requireWorkspaceForUser);

// DEBUG: Log user info on all autopilot requests
router.use((req, res, next) => {
  console.log("🤖 AUTOPILOT REQUEST:", {
    path: req.path,
    method: req.method,
    user: req.user ? {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
    } : 'NO USER',
    workspaceId: req.workspaceId || 'NO WORKSPACE',
  });
  next();
});

/* =====================================================
   AUTOPILOT SETTINGS
===================================================== */

/**
 * GET /autopilot/settings
 * Get autopilot settings for workspace or project
 */
router.get("/settings", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { projectId } = req.query;
    const settings = await getAutopilotSettings(req.workspaceId, projectId);

    res.json({
      success: true,
      settings: settings || {
        enabled: false,
        mode: 'assisted',
        message: 'No settings found. Autopilot is disabled by default.',
      },
    });
  } catch (err) {
    console.error("Get autopilot settings failed:", err);
    res.status(500).json({ error: "Failed to get settings" });
  }
});

/**
 * POST /autopilot/settings
 * Create or update autopilot settings
 */
router.post("/settings", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const {
      projectId,
      enabled,
      mode,
      autoAssign,
      autoDeadlineAdjust,
      autoEscalateBlockers,
      autoGenerateStandup,
      maxTasksPerUser,
      blockerThresholdHours,
      velocityDropThreshold,
      requireApproval,
      autoApproveAfterHours,
      approvalUserId,
    } = req.body;

    const settings = await createOrUpdateAutopilotSettings({
      workspaceId: req.workspaceId,
      projectId,
      enabled,
      mode,
      autoAssign,
      autoDeadlineAdjust,
      autoEscalateBlockers,
      autoGenerateStandup,
      maxTasksPerUser,
      blockerThresholdHours,
      velocityDropThreshold,
      requireApproval,
      autoApproveAfterHours,
      approvalUserId,
    });

    res.json({
      success: true,
      settings,
      message: enabled
        ? `Autopilot enabled in ${mode} mode`
        : 'Autopilot disabled',
    });
  } catch (err) {
    console.error("Update autopilot settings failed:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

/* =====================================================
   AUTOPILOT ACTIONS
===================================================== */

/**
 * GET /autopilot/actions
 * Get pending actions for approval
 */
router.get("/actions", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { projectId } = req.query;
    const actions = await getPendingActions(req.workspaceId, projectId);

    res.json({
      success: true,
      actions,
      count: actions.length,
    });
  } catch (err) {
    console.error("Get autopilot actions failed:", err);
    res.status(500).json({ error: "Failed to get actions" });
  }
});

/**
 * GET /autopilot/actions/:id
 * Get single action details
 */
router.get("/actions/:id", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const action = await getActionById(req.params.id);

    // Verify workspace access
    if (action.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json({
      success: true,
      action,
    });
  } catch (err) {
    console.error("Get action failed:", err);
    res.status(err.message === 'Action not found' ? 404 : 500).json({
      error: err.message,
    });
  }
});

/**
 * POST /autopilot/actions/:id/approve
 * Approve and execute an action
 */
router.post("/actions/:id/approve", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const action = await getActionById(req.params.id);

    // Verify workspace access
    if (action.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Check if autopilot is still enabled (warn but allow manual approval)
    const settings = await getAutopilotSettings(action.workspace_id, action.project_id);
    if (!settings || !settings.enabled) {
      console.warn(`⚠️ Approving action for disabled autopilot (workspace: ${action.workspace_id})`);
    }

    const result = await approveAction(req.params.id, req.user.id);

    res.json({
      success: true,
      action: result,
      message: `Action executed: ${action.action_type}`,
    });
  } catch (err) {
    console.error("Approve action failed:", err);
    res.status(500).json({
      error: "Failed to approve action",
      details: err.message,
    });
  }
});

/**
 * POST /autopilot/actions/:id/reject
 * Reject an action
 */
router.post("/actions/:id/reject", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const action = await getActionById(req.params.id);

    // Verify workspace access
    if (action.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { reason } = req.body;
    const result = await rejectAction(req.params.id, req.user.id, reason);

    res.json({
      success: true,
      action: result,
      message: 'Action rejected',
    });
  } catch (err) {
    console.error("Reject action failed:", err);
    res.status(500).json({ error: "Failed to reject action" });
  }
});

/* =====================================================
   AUTOPILOT RUNNER
===================================================== */

/**
 * POST /autopilot/run
 * Manually trigger autopilot analysis
 */
router.post("/run", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { projectId } = req.body;

    // Check if autopilot is enabled
    const settings = await getAutopilotSettings(req.workspaceId, projectId);
    if (!settings || !settings.enabled) {
      return res.status(400).json({
        error: "Autopilot is disabled",
        message: "Enable autopilot in settings before running analysis",
      });
    }

    const result = await runAutopilot(req.workspaceId, projectId);

    res.json({
      success: true,
      ...result,
      message: `Autopilot analyzed workspace and created ${result.actionsCreated} actions`,
    });
  } catch (err) {
    console.error("Run autopilot failed:", err);
    res.status(500).json({
      error: "Failed to run autopilot",
      details: err.message,
    });
  }
});

/**
 * GET /autopilot/stats
 * Get autopilot statistics
 */
router.get("/stats", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const { projectId } = req.query;
    const stats = await getAutopilotStats(req.workspaceId, projectId);

    res.json({
      success: true,
      stats: {
        pending: parseInt(stats.pending_count) || 0,
        executed: parseInt(stats.executed_count) || 0,
        rejected: parseInt(stats.rejected_count) || 0,
        autoApproved: parseInt(stats.auto_approved_count) || 0,
        avgConfidence: parseFloat(stats.avg_confidence) || 0,
      },
    });
  } catch (err) {
    console.error("Get autopilot stats failed:", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

/**
 * GET /autopilot/history
 * Get approved/executed/rejected action history with filters
 */
router.get("/history", allowRoles("admin", "manager"), async (req, res) => {
  try {
    const {
      projectId,
      page = 1,
      limit = 10,
      search = "",
      status = "all",
      fromDate = null,
      toDate = null,
    } = req.query;

    const result = await getAutopilotHistory({
      workspaceId: req.workspaceId,
      projectId,
      page,
      limit,
      search,
      status,
      fromDate,
      toDate,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("Get autopilot history failed:", err);
    res.status(500).json({ error: "Failed to get history" });
  }
});

export default router;
