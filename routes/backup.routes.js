// routes/backup.routes.js
import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  runBackup,
  getBackupLogs,
  getLastSuccessfulBackup,
  getActiveRunningBackup,
} from "../backup/backup.service.js";
import {
  createRecoveryJob,
  runRecoveryJob,
  listRecoveryJobs,
  getRunningRecoveryJob,
} from "../backup/workspaceRecovery.service.js";

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
    const activeRunning = await getActiveRunningBackup();
    if (activeRunning) {
      return res.status(409).json({
        error: "A backup is already running. Please wait for it to finish.",
        runningBackup: activeRunning,
      });
    }

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

/**
 * GET /superadmin/backups/recovery-jobs
 * List workspace recovery jobs
 */
router.get("/recovery-jobs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const jobs = await listRecoveryJobs(limit);
    res.json({ jobs });
  } catch (err) {
    console.error("[backup routes] recovery jobs list error:", err);
    res.status(500).json({ error: "Failed to fetch recovery jobs" });
  }
});

/**
 * GET /superadmin/backups/recovery-config
 * Reveal non-sensitive recovery config status for UI guardrails.
 */
router.get("/recovery-config", (_req, res) => {
  const source = String(process.env.RESTORE_SOURCE_DATABASE_URL || "").trim();
  res.json({
    serverDefaultSourceConfigured: !!source,
    managedAutoRecoveryEnabled: true,
    missingWorkspaceRecoverySupported: true,
    applyRequiresConfirmation: true,
  });
});

/**
 * POST /superadmin/backups/recover-workspace
 * Trigger workspace-level data recovery from configured source snapshot DB.
 * Existing rows are skipped/updated via upsert logic.
 */
router.post("/recover-workspace", async (req, res) => {
  try {
    const workspaceId = String(req.body?.workspaceId || "").trim();
    const sourceDatabaseUrl = String(req.body?.sourceDatabaseUrl || "").trim();
    const dryRun = !!req.body?.dryRun;
    const confirmApply = req.body?.confirmApply === true;
    const batchSize = Number(req.body?.batchSize) || 500;

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId);
    if (!isUuid) {
      return res.status(400).json({ error: "workspaceId must be a valid UUID" });
    }
    if (!dryRun && !confirmApply) {
      return res.status(400).json({
        error: "confirmApply=true is required for a workspace recovery apply run",
      });
    }
    const running = await getRunningRecoveryJob();
    if (running) {
      return res.status(409).json({
        error: "Another recovery job is already running. Wait for completion before starting a new one.",
        runningJob: running,
      });
    }

    const requestedBy =
      req.superadmin?.email ||
      req.superadmin?.username ||
      req.superadmin?.id ||
      "superadmin";

    const job = await createRecoveryJob({
      workspaceId,
      requestedBy,
      dryRun,
      batchSize,
      sourceDatabaseUrl,
    });

    res.status(202).json({
      message: dryRun
        ? "Workspace recovery dry-run started."
        : "Workspace recovery started.",
      job,
    });

    runRecoveryJob({
      jobId: job.id,
      workspaceId,
      dryRun,
      batchSize,
      sourceDatabaseUrl,
    }).catch((err) => {
      console.error("[backup routes] workspace recovery job error:", err.message);
    });
  } catch (err) {
    console.error("[backup routes] recover workspace error:", err);
    res.status(500).json({ error: "Failed to start workspace recovery" });
  }
});

export default router;
