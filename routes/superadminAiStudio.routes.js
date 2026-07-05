// routes/superadminAiStudio.routes.js
//
// Epic C — Superadmin AI Studio API surface (read + preview). Superadmin-guarded.
// Reuses the Epic-A/B registries via the studio service. Read-only + dry-run
// preview; persistence of overrides/audit is the documented DB-wiring step.
//
// MOUNT (add to index.js, before any global authMiddleware):
//   import superadminAiStudioRoutes from "./routes/superadminAiStudio.routes.js";
//   app.use("/superadmin/ai-studio", superadminAiStudioRoutes);

import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  getOverview,
  listProviderViewModels,
  listModelViewModels,
  listCapabilityViewModels,
  listRuntimeProfileViewModels,
  computeEffectiveConfig,
} from "../ai-platform/studio/aiStudioService.js";
import { permittedVerbs, ROLES, VERBS, OBJECT_TYPES } from "../ai-platform/governance/permissions.js";
import { LOCK_LEVELS } from "../ai-platform/governance/locks.js";

const router = express.Router();
router.use(requireSuperadmin);

router.get("/overview", (_req, res) => res.json(getOverview()));
router.get("/providers", (_req, res) => res.json(listProviderViewModels()));
router.get("/models", (_req, res) => res.json(listModelViewModels()));
router.get("/capabilities", (_req, res) => res.json(listCapabilityViewModels()));
router.get("/profiles", (_req, res) => res.json(listRuntimeProfileViewModels()));

router.get("/capabilities/:key/effective", (req, res) => {
  const lockLevel = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  const cfg = computeEffectiveConfig({ capabilityKey: req.params.key, lockLevel });
  if (!cfg) return res.status(404).json({ error: "Unknown capability" });
  res.json(cfg);
});

// Permission-matrix introspection (drives the UI's control gating).
router.get("/permissions", (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : "superadmin";
  const lockLevel = LOCK_LEVELS.includes(req.query.lock) ? req.query.lock : "workspace_customizable";
  res.json({
    role,
    lockLevel,
    roles: ROLES,
    verbs: VERBS,
    objectTypes: OBJECT_TYPES,
    permitted: permittedVerbs({ role, scope: "PLATFORM", lockLevel }),
  });
});

export default router;
