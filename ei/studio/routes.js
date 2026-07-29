// ei/studio/routes.js
//
// Enterprise Intelligence Studio — the read-only HTTP surface over the EI subsystems.
// Mounted at /intelligence-studio behind auth + workspace middleware; a guard makes the
// whole surface inert (404) unless EI_STUDIO_ENABLED is on for the workspace. Every
// handler delegates to service.js (which reuses the existing engines). GET-only — the
// Studio never mutates intelligence. UNVERIFIED AT RUNTIME (needs a migrated DB).

import { Router } from "express";
import { isEiStudioEnabled } from "../config/flags.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import * as svc from "./service.js";

const router = Router();
const wsId = (req) => req.workspaceId || req.headers["x-workspace-id"] || null;
const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e?.message || "studio_error" }); } };

router.use((req, res, next) => {
  if (!isEiStudioEnabled(wsId(req))) return res.status(404).json({ error: "intelligence_studio_disabled" });
  next();
});
// The Studio exposes sensitive organizational intelligence — admin only (defense in
// depth; the mount also gates the role).
router.use(allowRoles("admin"));

router.get("/overview",          wrap((req) => svc.getOverview({ workspaceId: wsId(req) })));
router.get("/evidence",          wrap(async (req) => ({ evidence: await svc.listEvidence({ workspaceId: wsId(req) }) })));
router.get("/attributions",      wrap(async (req) => ({ attributions: await svc.listAttributionsStudio({ workspaceId: wsId(req) }) })));
router.get("/traces",            wrap(async (req) => ({ traces: await svc.listTracesStudio({ workspaceId: wsId(req) }) })));
router.get("/traces/:id",        wrap((req) => svc.getTraceDetail({ workspaceId: wsId(req), traceId: req.params.id })));
router.get("/predictions",       wrap(async (req) => ({ predictions: await svc.listPredictionsStudio({ workspaceId: wsId(req) }) })));
router.get("/predictions/:id",   wrap((req) => svc.getPredictionDetail({ workspaceId: wsId(req), predictionId: req.params.id })));
router.get("/recommendations",   wrap(async (req) => ({ recommendations: await svc.listRecommendationsStudio({ workspaceId: wsId(req) }) })));
router.get("/recommendations/:id", wrap((req) => svc.getRecommendationDetail({ workspaceId: wsId(req), recommendationId: req.params.id })));
router.get("/executive",         wrap((req) => svc.getExecutive({ workspaceId: wsId(req) })));
router.get("/outcomes",          wrap(async (req) => ({ outcomes: await svc.listOutcomesStudio({ workspaceId: wsId(req) }) })));
router.get("/validation",        wrap((req) => svc.getValidation({ workspaceId: wsId(req) })));
router.get("/effectiveness",     wrap((req) => svc.getEffectiveness({ workspaceId: wsId(req) })));
router.get("/calibration",       wrap(async (req) => ({ model: await svc.getCalibrationStudio({ workspaceId: wsId(req) }) })));
router.get("/learning",          wrap((req) => svc.listLearningStudio({ workspaceId: wsId(req) })));
router.get("/experiments",       wrap(async (req) => ({ experiments: await svc.listExperimentsStudio({ workspaceId: wsId(req) }) })));
router.get("/memory",            wrap(async (req) => ({ memory: await svc.listMemoryStudio({ workspaceId: wsId(req) }) })));
router.get("/health",            wrap(async (req) => ({ health: await svc.getHealth({ workspaceId: wsId(req) }) })));
router.get("/graph",             wrap((req) => svc.getGraph({ workspaceId: wsId(req) })));
router.get("/search",            wrap((req) => svc.search({ workspaceId: wsId(req), q: req.query.q || "" })));

export default router;
