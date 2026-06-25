import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import { requirePlanFeature } from "../middleware/plan.middleware.js";
import {
  getUserPerformance,
  getAdminInsights,
  getExecutiveSummary,
  runMonthlyScoring,
  getCoachingEffectiveness,
  getUserTrend,
  getUserProjectPerformance,
  getWorkspaceHealth,
  getProjectsHealth,
  getTeamComparison,
  getWorkspaceDashboard,
  getUnifiedSnapshot,
  getUnifiedHistory,
  getCutoverStatus,
  getCutoverHealth,
  updateCutoverControl,
  getScoringConfig,
  updateScoringConfig,
  getGoalWorkspaceHealth,
  getProfitabilityOracleController,
  getResignationRadarController,
  getGhostWorkController,
  getOrgTruthMapController,
} from "./intelligence.controller.js";

console.log("🧠 Intelligence routes loaded");

const router = express.Router();

// Feature gates
const advIntel = requirePlanFeature("advanced_analytics");  // Strategic Intelligence page
const wsIntel  = requirePlanFeature("workspace_intelligence"); // Enterprise Intelligence page

/* =====================================================
   USER ROUTES — basic feature, no plan gate
===================================================== */

router.get("/user/performance",       authMiddleware, requireWorkspaceForUser, getUserPerformance);
router.get("/user/trend",             authMiddleware, requireWorkspaceForUser, getUserTrend);
router.get("/user/project-performance", authMiddleware, requireWorkspaceForUser, getUserProjectPerformance);

/* =====================================================
   ADMIN ROUTES — gated by advanced_analytics
   (Strategic Intelligence page, requiredFeature="advanced_analytics" in App.jsx)
===================================================== */

router.post("/admin/run-monthly-scoring",  authMiddleware, requireWorkspaceForUser, runMonthlyScoring);

router.get("/insights",                    authMiddleware, requireWorkspaceForUser, advIntel, getAdminInsights);
router.get("/admin/executive-summary",     authMiddleware, requireWorkspaceForUser, advIntel, getExecutiveSummary);
router.get("/admin/coaching-effectiveness",authMiddleware, requireWorkspaceForUser, advIntel, getCoachingEffectiveness);
router.get("/workspace/health",            authMiddleware, requireWorkspaceForUser, advIntel, getWorkspaceHealth);
router.get("/projects/health",             authMiddleware, requireWorkspaceForUser, advIntel, getProjectsHealth);
router.get("/team/comparison",             authMiddleware, requireWorkspaceForUser, advIntel, getTeamComparison);
router.get("/workspace/dashboard",         authMiddleware, requireWorkspaceForUser, advIntel, getWorkspaceDashboard);
router.get("/unified/snapshot",            authMiddleware, requireWorkspaceForUser, advIntel, getUnifiedSnapshot);
router.get("/unified/history",             authMiddleware, requireWorkspaceForUser, advIntel, getUnifiedHistory);
router.get("/cutover/status",              authMiddleware, requireWorkspaceForUser, advIntel, getCutoverStatus);
router.get("/cutover/health",              authMiddleware, requireWorkspaceForUser, advIntel, getCutoverHealth);
router.post("/cutover/controls",           authMiddleware, requireWorkspaceForUser, advIntel, updateCutoverControl);
router.get("/scoring-config",              authMiddleware, requireWorkspaceForUser, advIntel, getScoringConfig);
router.put("/scoring-config",              authMiddleware, requireWorkspaceForUser, advIntel, updateScoringConfig);

/* =====================================================
   GOALS HEALTH — gated by okr_goals (Goals module)
===================================================== */

router.get("/goals/health", authMiddleware, requireWorkspaceForUser, requirePlanFeature("okr_goals"), getGoalWorkspaceHealth);

/* =====================================================
   ENTERPRISE INTELLIGENCE — gated by workspace_intelligence
===================================================== */

router.get("/enterprise/profitability-oracle", authMiddleware, requireWorkspaceForUser, wsIntel, getProfitabilityOracleController);
router.get("/enterprise/resignation-radar",    authMiddleware, requireWorkspaceForUser, wsIntel, getResignationRadarController);
router.get("/enterprise/ghost-work",           authMiddleware, requireWorkspaceForUser, wsIntel, getGhostWorkController);
router.get("/enterprise/org-truth-map",        authMiddleware, requireWorkspaceForUser, wsIntel, getOrgTruthMapController);

export default router;
