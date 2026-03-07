import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireWorkspaceForUser } from "../middleware/workspace.middleware.js";
import {
  getDashboardExecutiveDetail,
  getDashboardOverview,
} from "../services/dashboard.service.js";

const router = express.Router();

router.use(authMiddleware);
router.use(requireWorkspaceForUser);

router.get("/overview", async (req, res) => {
  try {
    const data = await getDashboardOverview({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(data);
  } catch (err) {
    console.error("Dashboard overview failed:", err);
    res.status(500).json({ error: "Failed to load dashboard overview" });
  }
});

router.get("/executive-detail", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const data = await getDashboardExecutiveDetail({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.json(data);
  } catch (err) {
    console.error("Dashboard executive detail failed:", err);
    res.status(500).json({ error: "Failed to load executive detail" });
  }
});

export default router;
