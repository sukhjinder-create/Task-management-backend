import express from "express";
import { allowRoles } from "../../middleware/role.middleware.js";
import { validateSlackToken, migrateSlackWorkspace } from "./slack.migration.service.js";
import { createRunningMigrationImport } from "../../services/migrationHistory.service.js";

const router = express.Router();

router.use(allowRoles("admin"));

/**
 * POST /integrations/slack/validate
 * Validates the token and returns a preview (no DB writes).
 * Body: { token }
 */
router.post("/validate", async (req, res) => {
  const { token } = req.body;
  if (!token || (!token.startsWith("xoxb-") && !token.startsWith("xoxp-"))) {
    return res.status(400).json({ error: "Invalid token format. Must start with xoxb- (bot token) or xoxp- (user token)" });
  }

  try {
    const preview = await validateSlackToken(token);
    res.json(preview);
  } catch (err) {
    console.error("Slack validate error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /integrations/slack/migrate
 * Starts the migration in the background — responds immediately with { started, runId }.
 * Frontend polls GET /migration-history?source=slack to detect completion.
 * Body: { token, selectedChannelIds?, mode? }
 */
router.post("/migrate", async (req, res) => {
  const { token, selectedChannelIds, mode = "skip", autoJoin = false } = req.body;
  const workspaceId = req.workspaceId;
  const triggeredBy = req.user.id;

  if (!token || (!token.startsWith("xoxb-") && !token.startsWith("xoxp-"))) {
    return res.status(400).json({ error: "Invalid token format. Must start with xoxb- (bot token) or xoxp- (user token)" });
  }

  // Create a "running" record immediately so frontend can show progress
  let runRecord;
  try {
    runRecord = await createRunningMigrationImport({ workspaceId, source: "slack", triggeredBy });
  } catch (err) {
    console.error("Failed to create running record:", err.message);
    return res.status(500).json({ error: "Failed to start migration" });
  }

  // Respond immediately — migration runs in background
  res.json({ started: true, runId: runRecord.id, importNumber: runRecord.import_number });

  // Fire and forget
  migrateSlackWorkspace({
    token,
    workspaceId,
    triggeredBy,
    selectedChannelIds: selectedChannelIds || null,
    mode,
    autoJoin: !!autoJoin,
    runId: runRecord.id,
  }).catch((err) => {
    console.error("Slack background migration error:", err.message);
  });
});

export default router;
