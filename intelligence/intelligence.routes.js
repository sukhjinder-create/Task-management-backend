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
  getWorkspaceHealth,
  getProjectsHealth,
  getTeamComparison,
  getWorkspaceDashboard,
  getGoalWorkspaceHealth,
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

router.get(
  "/projects/health",
  authMiddleware,
  requireWorkspaceForUser,
  getProjectsHealth
);

router.get(
  "/team/comparison",
  authMiddleware,
  requireWorkspaceForUser,
  getTeamComparison
);

router.get(
  "/workspace/dashboard",
  authMiddleware,
  requireWorkspaceForUser,
  getWorkspaceDashboard
);

/*
  GET /intelligence/okr/health
  ────────────────────────────
  Returns aggregated OKR portfolio health for the workspace.
  The intelligence layer actively watches OKRs through this endpoint.

  Response includes:
  • totalObjectives    — how many OKRs exist
  • atRiskCount        — at_risk or off_track objectives
  • stalledCount       — objectives with 0% progress after 14+ days
  • behindCount        — objectives behind expected pace
  • avgHealthScore     — 0–100 portfolio health
  • avgProgress        — mean progress across all objectives
  • completedCount     — objectives at 100%
  • byStatus           — count per status bucket
*/
router.get(
  "/goals/health",
  authMiddleware,
  requireWorkspaceForUser,
  getGoalWorkspaceHealth
);

export default router;
