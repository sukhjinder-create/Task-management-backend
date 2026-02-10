import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  getUserPerformance,
  getAdminInsights,
  getExecutiveSummary,
} from "./intelligence.controller.js";
import { runMonthlyScoring } from "./intelligence.controller.js";

const router = express.Router();

/**
 * USER — Monthly performance
 */
router.get(
  "/user/performance",
  authMiddleware,
  requireWorkspaceForUser,
  getUserPerformance
);

/**
 * ADMIN — Organization insights
 */
router.get(
  "/admin/insights",
  authMiddleware,
  requireWorkspaceForUser,
  getAdminInsights
);

/**
 * ADMIN — Executive summary
 */
router.get(
  "/admin/executive-summary",
  authMiddleware,
  requireWorkspaceForUser,
  getExecutiveSummary
);

router.post(
  "/admin/run-monthly-scoring",
  authMiddleware,
  requireWorkspaceForUser,
  runMonthlyScoring
);

export default router;
