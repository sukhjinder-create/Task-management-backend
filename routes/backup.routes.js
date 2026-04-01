// routes/backup.routes.js
import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import { runBackup, getBackupLogs, getLastSuccessfulBackup } from "../backup/backup.service.js";

const router = express.Router();

// All routes require superadmin
router.use(requireSuperadmin);

/**
 * GET /superadmin/backups
 * List recent backup logs
 */
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const logs = await getBackupLogs(limit);
    res.json({ logs });
  } catch (err) {
    console.error("[backup routes] list error:", err);
    res.status(500).json({ error: "Failed to fetch backup logs" });
  }
});

/**
 * GET /superadmin/backups/latest
 * Get the most recent successful backup
 */
router.get("/latest", async (req, res) => {
  try {
    const latest = await getLastSuccessfulBackup();
    res.json({ backup: latest });
  } catch (err) {
    console.error("[backup routes] latest error:", err);
    res.status(500).json({ error: "Failed to fetch latest backup" });
  }
});

/**
 * POST /superadmin/backups/trigger
 * Manually trigger a backup
 */
router.post("/trigger", async (req, res) => {
  try {
    // Start backup async — respond immediately with 202
    res.status(202).json({ message: "Backup started. Check logs for status." });
    // Run backup after response is sent
    runBackup("manual").catch((err) =>
      console.error("[backup routes] manual backup error:", err.message)
    );
  } catch (err) {
    console.error("[backup routes] trigger error:", err);
    res.status(500).json({ error: "Failed to trigger backup" });
  }
});

export default router;
