// middleware/plan.middleware.js

import workspaceService from "../services/workspace.service.js";

/**
 * Feature gating middleware based on billing plan.
 *
 * Usage:
 *   router.get(
 *     "/reports",
 *     requireWorkspaceForUser,
 *     requirePlanFeature("reports"),
 *     controller
 *   );
 *
 * Assumes:
 *  - requireWorkspaceForUser has already run
 *  - req.workspace is available
 */

export function requirePlanFeature(featureKey) {
  return function (req, res, next) {
    const workspace = req.workspace;

    if (!workspace) {
      return res.status(500).json({
        error: "Workspace context missing for plan enforcement",
      });
    }

    const allowed = workspaceService.hasFeature(workspace, featureKey);

    if (!allowed) {
      return res.status(403).json({
        error: `Feature '${featureKey}' is not available on your current plan`,
      });
    }

    next();
  };
}
