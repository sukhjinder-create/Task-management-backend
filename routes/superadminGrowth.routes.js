import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import { getGrowthDashboard } from "../growth/growthDashboard.service.js";
import { getGrowthQueueDepth } from "../growth/growthCollector.js";

const router = express.Router();
router.use(requireSuperadmin);

router.get("/dashboard", async (req, res) => {
  try {
    const dashboard = await getGrowthDashboard(req.query);
    return res.json(dashboard);
  } catch (error) {
    const status = error.message.includes("range") ? 400 : 500;
    if (status === 500) console.error("[growth dashboard] failed:", error.message);
    return res.status(status).json({ error: status === 500 ? "Failed to load Growth Intelligence" : error.message });
  }
});

router.get("/health", (_req, res) => {
  return res.json({ status: "ok", queue_depth: getGrowthQueueDepth() });
});

export default router;

