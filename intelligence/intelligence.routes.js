import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  getUserPerformance,
  getAdminInsights,
  getExecutiveSummary,
  runMonthlyScoring,
  getCoachingEffectiveness,
  getUserTrend,
  getUserProjectPerformance,
} from "./intelligence.controller.js";
import {
  getWorkspaceHealth
} from "./intelligence.controller.js";


console.log("🧠 Intelligence routes loaded");

const router = express.Router();

/* =====================================================
   USER ROUTES
===================================================== */

router.get(
  "/user/performance",
  authMiddleware,
  requireWorkspaceForUser,
  getUserPerformance
);

/* =====================================================
   ADMIN ROUTES
===================================================== */

router.post(
  "/admin/run-monthly-scoring",
  authMiddleware,
  requireWorkspaceForUser,
  runMonthlyScoring
);

router.get(
  "/insights",
  authMiddleware,
  requireWorkspaceForUser,
  getAdminInsights
);

 console.log("Executive summary hit");
router.get(
  "/admin/executive-summary",
  authMiddleware,
  requireWorkspaceForUser,
  getExecutiveSummary
);

router.get(
  "/admin/coaching-effectiveness",
  authMiddleware,
  requireWorkspaceForUser,
  getCoachingEffectiveness
);

/**
 * USER — Monthly trend
 */
router.get(
  "/user/trend",
  authMiddleware,
  requireWorkspaceForUser,
  getUserTrend
);

/**
 * USER — Project performance
 */
router.get(
  "/user/project-performance",
  authMiddleware,
  requireWorkspaceForUser,
  getUserProjectPerformance
);

router.get(
  "/workspace/health",
  getWorkspaceHealth
);

export default router;
