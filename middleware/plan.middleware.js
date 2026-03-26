// middleware/plan.middleware.js
//
// Feature gating based on billing_plans.features (loaded from DB by workspace.middleware).
// workspace.middleware must run first so req.workspace.planFeatures is populated.

/**
 * Core modules always available on every plan — matches what the user specified:
 * "dashboard, projects, tasks, notifications, profile, admin in every plan by default"
 */
const ALWAYS_ALLOWED = new Set([
  "task_management",
  "project_management",
  "my_tasks",
  "subtasks",
  "comments",
  "file_uploads",
  "notifications",
  "tags",
]);

/**
 * Backward-compat alias map.
 * Old route keys (left) → MASTER_FEATURES keys stored in billing_plans.features (right).
 */
const KEY_ALIASES = {
  chat:    "team_chat",
  reports: "basic_reporting",
  huddle:  "video_huddle",
};

export function requirePlanFeature(featureKey) {
  return function (req, res, next) {
    const workspace = req.workspace;

    if (!workspace) {
      return res.status(500).json({ error: "Workspace context missing for plan enforcement" });
    }

    // Active free trial → all features unlocked
    if (workspace.onTrial) return next();

    // Resolve alias if old key is used
    const resolvedKey = KEY_ALIASES[featureKey] ?? featureKey;

    // Core modules are never gated
    if (ALWAYS_ALLOWED.has(resolvedKey)) return next();

    const features = Array.isArray(workspace.planFeatures) ? workspace.planFeatures : [];

    if (!features.includes(resolvedKey)) {
      return res.status(403).json({
        error: `This feature is not available on your current plan. Please upgrade to access it.`,
        feature: resolvedKey,
        upgrade_required: true,
      });
    }

    next();
  };
}
