import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import { getPlatformAiepDashboard } from "../adaptive/evaluation/adaptiveIntelligenceEvaluation.service.js";
import {
  createAdaptiveExperiment,
  evaluateAdaptiveExperiment,
  getPlatformAdaptiveCoach,
  listAdaptiveExperiments,
  setAdaptiveExperimentStatus,
} from "../adaptive/evaluation/finalIntelligenceCompletion.service.js";

const router = express.Router();
router.use(requireSuperadmin);

router.get("/dashboard", async (req, res) => {
  try {
    const dashboard = await getPlatformAiepDashboard({ days: req.query.days });
    return res.json(dashboard);
  } catch (error) {
    console.error("[superadmin adaptive intelligence] dashboard failed:", error.message);
    return res.status(500).json({ error: "Failed to load platform Adaptive Intelligence Evaluation" });
  }
});

router.get("/coach", async (req, res) => {
  try {
    const coach = await getPlatformAdaptiveCoach({ days: req.query.days });
    return res.json(coach);
  } catch (error) {
    console.error("[superadmin adaptive coach] failed:", error.message);
    return res.status(500).json({ error: "Failed to load platform Adaptive Intelligence Coach" });
  }
});

router.get("/experiments", async (req, res) => {
  try {
    const experiments = await listAdaptiveExperiments({
      platform: true,
      includeArchived: req.query.includeArchived === "true",
    });
    return res.json({ experiments });
  } catch (error) {
    console.error("[superadmin adaptive experiments] list failed:", error.message);
    return res.status(500).json({ error: "Failed to load platform Adaptive Experiments" });
  }
});

router.post("/experiments", async (req, res) => {
  try {
    const experiment = await createAdaptiveExperiment({
      payload: req.body || {},
      platform: true,
    });
    return res.status(201).json(experiment);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post("/experiments/:id/evaluate", async (req, res) => {
  try {
    const result = await evaluateAdaptiveExperiment({
      experimentId: req.params.id,
      days: req.body?.days || req.query.days,
      platform: true,
    });
    if (!result) return res.status(404).json({ error: "Experiment not found" });
    return res.json(result);
  } catch (error) {
    console.error("[superadmin adaptive experiments] evaluation failed:", error.message);
    return res.status(500).json({ error: "Failed to evaluate platform experiment" });
  }
});

router.patch("/experiments/:id/status", async (req, res) => {
  try {
    const experiment = await setAdaptiveExperimentStatus({
      experimentId: req.params.id,
      status: req.body?.status,
      platform: true,
    });
    if (!experiment) return res.status(404).json({ error: "Experiment not found" });
    return res.json(experiment);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

export default router;
