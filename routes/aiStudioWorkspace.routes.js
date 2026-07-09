// routes/aiStudioWorkspace.routes.js
//
// Epic C — Workspace AI Studio API. Workspace admins see/edit only what the lock
// model permits. Guarded by auth + workspace + admin role. Reuses the Studio
// services + governance. DB-backed override writes are schema-tolerant and
// UNVERIFIED AT RUNTIME.
//
// Mounted in index.js as:
//   app.use("/ai-studio", authMiddleware, requireWorkspaceForUser, allowRoles("admin"), aiStudioWorkspaceRoutes)

import express from "express";
import {
  getOverview, listCapabilityViewModels, getWorkspaceControls, computeEffectiveConfig,
  listProviderViewModels, listModelViewModels, listRuntimeProfileViewModels,
} from "../ai-platform/studio/aiStudioService.js";
import { can } from "../ai-platform/governance/permissions.js";
import { LOCK_LEVELS } from "../ai-platform/governance/locks.js";
import { upsertCapabilityConfig } from "../ai-platform/studio/configStore.service.js";
import { listPrompts } from "../ai-platform/studio/promptRegistry.service.js";
import * as telemetry from "../ai-platform/studio/telemetry.service.js";
import { runPlayground } from "../ai-platform/studio/playground.service.js";

const router = express.Router();
const wsRole = (req) => (req.user?.role === "admin" ? "workspace_admin" : "workspace_viewer");
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

// Option lists so the workspace UI can offer dropdowns (same registries as superadmin; read-only).
router.get("/providers", (_req, res) => res.json(listProviderViewModels()));
router.get("/models", (_req, res) => res.json(listModelViewModels()));
router.get("/profiles", (_req, res) => res.json(listRuntimeProfileViewModels()));
router.get("/prompts", wrap(async (_req, res) => res.json(await listPrompts())));

router.get("/overview", (_req, res) => {
  const o = getOverview();
  res.json({ platform: { enabled: o.platform.enabled, contractVersion: o.platform.contractVersion }, counts: { capabilities: o.counts.capabilities } });
});

router.get("/capabilities", (_req, res) =>
  res.json(listCapabilityViewModels().map((c) => ({ key: c.key, name: c.name, category: c.category, description: c.description, lock: c.lock }))));

router.get("/capabilities/:key/controls", (req, res) => {
  const lock = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  const controls = getWorkspaceControls({ role: wsRole(req), capabilityKey: req.params.key, lockLevel: lock });
  controls ? res.json(controls) : res.status(404).json({ error: "Unknown capability" });
});

// Preview an override (no persistence).
router.post("/capabilities/:key/preview-override", (req, res) => {
  const lock = LOCK_LEVELS.includes(req.body?.lock) ? req.body.lock : "workspace_customizable";
  const decision = can({ role: wsRole(req), verb: "override", objectType: "capability_config", scope: { workspaceId: req.workspaceId }, lockLevel: lock });
  if (!decision.allowed) return res.status(403).json({ error: "Override not permitted", reason: decision.reason });
  const cfg = computeEffectiveConfig({ capabilityKey: req.params.key, workspaceOverride: req.body?.override || {}, lockLevel: lock });
  cfg ? res.json({ allowed: true, preview: cfg }) : res.status(404).json({ error: "Unknown capability" });
});

// Persist a workspace override (permission + lock enforced; validated in the service).
router.put("/capabilities/:key/override", wrap(async (req, res) => {
  const lock = LOCK_LEVELS.includes(req.body?.lock) ? req.body.lock : "workspace_customizable";
  const decision = can({ role: wsRole(req), verb: "override", objectType: "capability_config", scope: { workspaceId: req.workspaceId }, lockLevel: lock });
  if (!decision.allowed) return res.status(403).json({ error: "Override not permitted", reason: decision.reason });
  const ov = req.body?.override || {};
  const r = await upsertCapabilityConfig({
    capabilityKey: req.params.key, scope: req.workspaceId, workspaceId: req.workspaceId,
    provider: ov.provider ?? null, model: ov.model ?? null, promptKey: ov.promptKey ?? null,
    runtimeProfile: ov.profile ?? null, actorId: req.user?.id,
  });
  r.ok ? res.json(r) : res.status(400).json(r);
}));

router.get("/usage", wrap(async (req, res) => res.json(await telemetry.getUsage({ workspaceId: req.workspaceId, period: req.query.period }))));
router.get("/cost", wrap(async (req, res) => res.json(await telemetry.getCost({ workspaceId: req.workspaceId, period: req.query.period }))));
router.post("/playground", wrap(async (req, res) => res.json(await runPlayground({ capability: req.body?.capability, prompt: req.body?.prompt, workspaceId: req.workspaceId, overrides: req.body?.overrides || {} }))));

export default router;
