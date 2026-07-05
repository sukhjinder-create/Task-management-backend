// routes/aiStudioWorkspace.routes.js
//
// Epic C — Workspace AI Studio API surface. Workspace admins see/edit only what
// the lock model permits. Guarded by auth + workspace + admin role. Read + dry-run
// preview (no persistence in this layer). Reuses the studio service + governance.
//
// MOUNT (add to index.js):
//   import aiStudioWorkspaceRoutes from "./routes/aiStudioWorkspace.routes.js";
//   app.use("/ai-studio", authMiddleware, requireWorkspaceForUser, allowRoles("admin"), aiStudioWorkspaceRoutes);

import express from "express";
import {
  getOverview,
  listCapabilityViewModels,
  getWorkspaceControls,
  computeEffectiveConfig,
} from "../ai-platform/studio/aiStudioService.js";
import { can } from "../ai-platform/governance/permissions.js";
import { LOCK_LEVELS } from "../ai-platform/governance/locks.js";

const router = express.Router();

// Workspace admins map to the workspace_admin governance role.
function wsRole(req) {
  return req.user?.role === "admin" ? "workspace_admin" : "workspace_viewer";
}

router.get("/overview", (_req, res) => {
  const o = getOverview();
  // Workspace view: platform counts only, no platform-internal config.
  res.json({ platform: { enabled: o.platform.enabled, contractVersion: o.platform.contractVersion }, counts: { capabilities: o.counts.capabilities } });
});

router.get("/capabilities", (_req, res) => {
  // Only workspace-relevant fields.
  res.json(listCapabilityViewModels().map((c) => ({ key: c.key, name: c.name, category: c.category, description: c.description, lock: c.lock })));
});

router.get("/capabilities/:key/controls", (req, res) => {
  const lockLevel = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  const controls = getWorkspaceControls({ role: wsRole(req), capabilityKey: req.params.key, lockLevel });
  if (!controls) return res.status(404).json({ error: "Unknown capability" });
  res.json(controls);
});

// Dry-run: validate a requested override + preview the effective config (no persist).
router.post("/capabilities/:key/preview-override", (req, res) => {
  const lockLevel = LOCK_LEVELS.includes(req.body?.lock) ? req.body.lock : "workspace_customizable";
  const decision = can({ role: wsRole(req), verb: "override", objectType: "capability_config", scope: { workspaceId: req.workspaceId }, lockLevel });
  if (!decision.allowed) return res.status(403).json({ error: "Override not permitted", reason: decision.reason });
  const cfg = computeEffectiveConfig({ capabilityKey: req.params.key, workspaceOverride: req.body?.override || {}, lockLevel });
  if (!cfg) return res.status(404).json({ error: "Unknown capability" });
  res.json({ allowed: true, preview: cfg, note: "Preview only — persistence is a DB-layer step" });
});

export default router;
