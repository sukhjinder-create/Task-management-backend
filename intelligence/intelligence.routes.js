import express from "express";
import {
  getUserPerformance,
  getAdminInsights,
  getExecutiveSummary,
  runMonthlyScoring,
  getCoachingEffectiveness,
} from "./intelligence.controller.js";

console.log("🧠 Intelligence routes loaded");

const router = express.Router();

/* ======================================================
   HEALTH CHECK (DEBUG / ROUTE CONFIRMATION)
====================================================== */
router.get("/__ping", (req, res) => {
  res.json({ ok: true });
});

/* ======================================================
   USER
====================================================== */
router.get("/user/performance", getUserPerformance);

/* ======================================================
   ADMIN — READ
====================================================== */
router.get("/admin/insights", getAdminInsights);

router.get("/admin/executive-summary", getExecutiveSummary);

router.get(
  "/admin/coaching-effectiveness",
  getCoachingEffectiveness
);

/* ======================================================
   ADMIN — WRITE / CONTROL
====================================================== */
router.post(
  "/admin/run-monthly-scoring",
  runMonthlyScoring
);

export default router;
