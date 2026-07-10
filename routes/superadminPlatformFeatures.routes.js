// routes/superadminPlatformFeatures.routes.js
//
// Superadmin toggles for enabling the Execution Platform / Enterprise Intelligence on a
// per-workspace basis, from the UI. Mounted OUTSIDE the feature guards (so a disabled
// platform can still be enabled). Reuses config/platformFeatures.js (DB + cache).

import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import { getWorkspaceFeatures, setFeatureEnabled } from "../config/platformFeatures.js";

const router = express.Router();
router.use(requireSuperadmin);
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };
const FEATURES = ["execution", "intelligence"];

// GET /superadmin/platform-features?workspaceId=... → { execution:bool, intelligence:bool }
router.get("/", wrap(async (req, res) => {
  const workspaceId = req.query.workspaceId;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
  const current = await getWorkspaceFeatures(workspaceId);
  res.json({ execution: Boolean(current.execution), intelligence: Boolean(current.intelligence) });
}));

// POST /superadmin/platform-features/:feature  { workspaceId, enabled }
router.post("/:feature", wrap(async (req, res) => {
  const feature = req.params.feature;
  if (!FEATURES.includes(feature)) return res.status(400).json({ error: "unknown_feature" });
  const { workspaceId, enabled } = req.body || {};
  if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
  const r = await setFeatureEnabled({ feature, workspaceId, enabled: Boolean(enabled), actorId: req.superadmin?.id });
  r.ok ? res.json(r) : res.status(400).json(r);
}));

export default router;
