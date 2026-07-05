// routes/superadminAiStudio.routes.js
//
// Epic C — Superadmin AI Studio API (complete: read + CRUD + playground +
// telemetry). Superadmin-guarded. Reuses the Epic-A/B registries + Studio services.
// DB-backed writes are schema-tolerant (never 500 on an un-migrated DB) and are
// UNVERIFIED AT RUNTIME until a migrated database is available.
//
// Mounted in index.js as: app.use("/superadmin/ai-studio", superadminAiStudioRoutes)

import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  getOverview, listProviderViewModels, listModelViewModels,
  listCapabilityViewModels, listRuntimeProfileViewModels, computeEffectiveConfig,
} from "../ai-platform/studio/aiStudioService.js";
import { permittedVerbs, ROLES, VERBS, OBJECT_TYPES } from "../ai-platform/governance/permissions.js";
import { LOCK_LEVELS } from "../ai-platform/governance/locks.js";
import * as prompts from "../ai-platform/studio/promptRegistry.service.js";
import * as config from "../ai-platform/studio/configStore.service.js";
import * as telemetry from "../ai-platform/studio/telemetry.service.js";
import { listAudit } from "../ai-platform/studio/audit.service.js";
import { runPlayground } from "../ai-platform/studio/playground.service.js";

const router = express.Router();
router.use(requireSuperadmin);
const actor = (req) => req.superadmin?.id || req.user?.id || "superadmin";
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

// ── Overview / registries ─────────────────────────────────────────────────────
router.get("/overview", (_req, res) => res.json(getOverview()));
router.get("/providers", (_req, res) => res.json(listProviderViewModels()));
router.get("/models", (_req, res) => res.json(listModelViewModels()));
router.get("/capabilities", (_req, res) => res.json(listCapabilityViewModels()));
router.get("/profiles", (_req, res) => res.json(listRuntimeProfileViewModels()));
router.get("/capabilities/:key/effective", (req, res) => {
  const lock = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  const cfg = computeEffectiveConfig({ capabilityKey: req.params.key, lockLevel: lock });
  cfg ? res.json(cfg) : res.status(404).json({ error: "Unknown capability" });
});
router.get("/permissions", (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : "superadmin";
  const lock = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  res.json({ role, lockLevel: lock, roles: ROLES, verbs: VERBS, objectTypes: OBJECT_TYPES, permitted: permittedVerbs({ role, scope: "PLATFORM", lockLevel: lock }) });
});

// ── Prompt registry + versioning ──────────────────────────────────────────────
router.get("/prompts", wrap(async (_req, res) => res.json(await prompts.listPrompts())));
router.get("/prompts/:key", wrap(async (req, res) => res.json(await prompts.getPrompt(req.params.key))));
router.post("/prompts", wrap(async (req, res) => res.json(await prompts.createPrompt({ ...req.body, createdBy: actor(req) }))));
router.get("/prompts/:key/versions", wrap(async (req, res) => res.json(await prompts.listVersions(req.params.key))));
router.post("/prompts/:key/versions", wrap(async (req, res) => res.json({ version: await prompts.createVersion({ promptKey: req.params.key, body: req.body?.body, notes: req.body?.notes, createdBy: actor(req) }) })));
router.post("/prompts/:key/versions/:version/transition", wrap(async (req, res) => {
  const r = await prompts.transitionVersion({ promptKey: req.params.key, version: Number(req.params.version), to: req.body?.to, requireApproval: !!req.body?.requireApproval, approved: !!req.body?.approved, actorId: actor(req) });
  r.ok ? res.json(r) : res.status(400).json(r);
}));

// ── Config mutations (providers / models / profiles / capabilities / locks) ────
router.post("/providers", wrap(async (req, res) => res.json(await config.upsertProvider({ ...req.body, actorId: actor(req) }))));
router.post("/models", wrap(async (req, res) => res.json(await config.upsertModel({ ...req.body, actorId: actor(req) }))));
router.post("/profiles", wrap(async (req, res) => res.json(await config.upsertRuntimeProfile({ ...req.body, actorId: actor(req) }))));
router.post("/capability-config", wrap(async (req, res) => {
  const r = await config.upsertCapabilityConfig({ ...req.body, scope: "PLATFORM", actorId: actor(req) });
  r.ok ? res.json(r) : res.status(400).json(r);
}));
router.post("/capability-config/:key/lock", wrap(async (req, res) => {
  const r = await config.setLock({ capabilityKey: req.params.key, scope: "PLATFORM", lockLevel: req.body?.lockLevel, actorId: actor(req) });
  r.ok ? res.json(r) : res.status(400).json(r);
}));

// ── Audit ─────────────────────────────────────────────────────────────────────
router.get("/audit", wrap(async (req, res) => res.json(await listAudit({ objectType: req.query.objectType || null, limit: req.query.limit }))));

// ── Playground ────────────────────────────────────────────────────────────────
router.post("/playground", wrap(async (req, res) => res.json(await runPlayground({ capability: req.body?.capability, prompt: req.body?.prompt, overrides: req.body?.overrides || {} }))));

// ── Telemetry / usage / cost / health / traces ────────────────────────────────
router.get("/usage", wrap(async (req, res) => res.json(await telemetry.getUsage({ period: req.query.period }))));
router.get("/cost", wrap(async (req, res) => res.json(await telemetry.getCost({ period: req.query.period }))));
router.get("/health/capabilities", wrap(async (req, res) => res.json(await telemetry.getCapabilityHealth({ period: req.query.period }))));
router.get("/health/providers", wrap(async (req, res) => res.json(await telemetry.getProviderHealth({ period: req.query.period }))));
router.get("/traces", wrap(async (req, res) => res.json(await telemetry.getRecentTraces({ limit: req.query.limit }))));

export default router;
