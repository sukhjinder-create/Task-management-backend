import express from "express";
import {
  autoDiscoverCliTests,
  generateTaskTestCases,
  generateAndSaveTestFile,
  getTestingAgentRunById,
  getTestingAgentSettings,
  listTestingAgentProjectProfiles,
  listTestingAgentRuns,
  listTestingAgentTaskOptions,
  runApiTests,
  runCliMultiScenario,
  runTaskTests,
  upsertTestingAgentProjectProfile,
  upsertTestingAgentSettings,
} from "../services/testingAgent.service.js";
import { runBrowserAgent, autoDiscoverAndTest, runMultiScenario, runDeepExploration } from "../services/browserAgent.service.js";

const router = express.Router();

function canManage(user) {
  return user?.role === "admin" || user?.role === "manager";
}

router.get("/settings", async (req, res) => {
  try {
    const settings = await getTestingAgentSettings(req.workspaceId);
    res.json(settings);
  } catch (error) {
    console.error("Testing agent settings load failed:", error);
    res.status(500).json({ error: "Failed to load testing agent settings" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Only admin/manager can update testing agent settings" });
    }

    const {
      enabled = true,
      autoGenerateOnGit = true,
      autoRunOnGit = false,
      maxRuntimeSeconds = 900,
      testCommands = [],
    } = req.body || {};

    const settings = await upsertTestingAgentSettings({
      workspaceId: req.workspaceId,
      enabled,
      autoGenerateOnGit,
      autoRunOnGit,
      maxRuntimeSeconds,
      testCommands,
      actorId: req.user?.id || null,
    });

    res.json(settings);
  } catch (error) {
    console.error("Testing agent settings update failed:", error);
    res.status(500).json({ error: "Failed to update testing agent settings", details: error.message });
  }
});

router.get("/tasks/options", async (req, res) => {
  try {
    const search = String(req.query.search || "");
    const limit = Number(req.query.limit || 20);
    const items = await listTestingAgentTaskOptions({
      workspaceId: req.workspaceId,
      search,
      limit,
    });
    res.json(items);
  } catch (error) {
    console.error("Testing agent task options load failed:", error);
    res.status(500).json({ error: "Failed to load task options" });
  }
});

router.get("/projects/profiles", async (req, res) => {
  try {
    const profiles = await listTestingAgentProjectProfiles({
      workspaceId: req.workspaceId,
      search: String(req.query.search || ""),
    });
    res.json(profiles);
  } catch (error) {
    console.error("Testing project profiles load failed:", error);
    res.status(500).json({ error: "Failed to load project profiles" });
  }
});

router.put("/projects/:projectId/profile", async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ error: "Only admin/manager can update project profile" });
    }
    const { projectId } = req.params;
    const {
      repoPath = null,
      framework = null,
      commands = [],
      enabled = true,
    } = req.body || {};

    const profile = await upsertTestingAgentProjectProfile({
      workspaceId: req.workspaceId,
      projectId,
      repoPath,
      framework,
      commands,
      enabled,
      actorId: req.user?.id || null,
    });

    res.json(profile);
  } catch (error) {
    console.error("Testing project profile update failed:", error);
    res.status(500).json({ error: "Failed to update project profile", details: error.message });
  }
});

router.post("/tasks/:taskId/generate", async (req, res) => {
  try {
    const result = await generateTaskTestCases({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("Testing agent generate failed:", error);
    res.status(400).json({ error: "Failed to generate test cases", details: error.message });
  }
});

router.post("/tasks/:taskId/run", async (req, res) => {
  try {
    const result = await runTaskTests({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("Testing agent run failed:", error);
    res.status(400).json({ error: "Failed to run tests", details: error.message });
  }
});

// Auto-discover CLI — scans repo, AI decides what to test, runs it automatically
router.post("/tasks/:taskId/auto-discover-cli", async (req, res) => {
  try {
    const result = await autoDiscoverCliTests({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("Auto-discover CLI failed:", error);
    res.status(400).json({ error: "Auto-discover CLI failed", details: error.message });
  }
});

// Multi-scenario CLI — runs 4 scenario types (unit/integration/security/performance)
router.post("/tasks/:taskId/multi-scenario-cli", async (req, res) => {
  try {
    const result = await runCliMultiScenario({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("Multi-scenario CLI failed:", error);
    res.status(400).json({ error: "Multi-scenario CLI failed", details: error.message });
  }
});

// API testing — LLM generates HTTP test scenarios, executes them, returns AI insights
router.post("/tasks/:taskId/api-test", async (req, res) => {
  try {
    const { baseUrl, authToken, openApiSpec } = req.body || {};
    if (!baseUrl || !String(baseUrl).trim().startsWith("http")) {
      return res.status(400).json({ error: "baseUrl is required and must be a valid HTTP URL" });
    }
    const result = await runApiTests({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      baseUrl: String(baseUrl).trim(),
      authToken: authToken ? String(authToken).trim() : null,
      openApiSpec: openApiSpec || null,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("API test run failed:", error);
    res.status(400).json({ error: "API test run failed", details: error.message });
  }
});

// Generate test file — creates actual test code for the detected framework
router.post("/tasks/:taskId/generate-test-file", async (req, res) => {
  try {
    const { saveToRepo = false } = req.body || {};
    const result = await generateAndSaveTestFile({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      saveToRepo: Boolean(saveToRepo),
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
    });
    res.json(result);
  } catch (error) {
    console.error("Test file generation failed:", error);
    res.status(400).json({ error: "Test file generation failed", details: error.message });
  }
});

// ── Async-run helper ──
// Fires the service, responds with { runId, status:'running' } as soon as the DB run
// record exists (via onRunCreated callback), then lets execution continue in background.
// If the service throws BEFORE creating the run (e.g. task not found), sends 400.
function runAsync(serviceCall, res, errorLabel) {
  let resolve;
  const gate = new Promise((r) => { resolve = r; });

  serviceCall({
    onRunCreated: (runId) => resolve({ runId }),
  }).catch((err) => {
    resolve({ error: err.message });
  });

  gate.then((result) => {
    if (res.headersSent) return;
    if (result.error) {
      res.status(400).json({ error: errorLabel, details: result.error });
    } else {
      res.json({ runId: result.runId, status: "running" });
    }
  });
}

// Browser agent run
router.post("/tasks/:taskId/browser-run", (req, res) => {
  const { instructions, timeoutMs } = req.body || {};
  if (!instructions || !String(instructions).trim()) {
    return res.status(400).json({ error: "instructions are required" });
  }
  runAsync(
    ({ onRunCreated }) => runBrowserAgent({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      instructions: String(instructions).trim(),
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: Math.min(Math.max(Number(timeoutMs || 300000), 5000), 600000),
      onRunCreated,
    }),
    res,
    "Browser agent run failed"
  );
});

// Auto-discover: give URL → AI explores page → builds & runs its own test plan
router.post("/tasks/:taskId/auto-discover", (req, res) => {
  const { url, timeoutMs } = req.body || {};
  if (!url || !String(url).trim().startsWith("http")) {
    return res.status(400).json({ error: "url is required and must be a valid HTTP URL" });
  }
  runAsync(
    ({ onRunCreated }) => autoDiscoverAndTest({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      url: String(url).trim(),
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: Math.min(Math.max(Number(timeoutMs || 45000), 10000), 180000),
      onRunCreated,
    }),
    res,
    "Auto-discover failed"
  );
});

// Multi-scenario: describe feature → AI generates 4 scenario types → runs them all
router.post("/tasks/:taskId/multi-scenario", async (req, res) => {
  try {
    const { description, url, timeoutMs } = req.body || {};
    if (!description || String(description).trim().length < 5) {
      return res.status(400).json({ error: "description is required (min 5 characters)" });
    }
    const result = await runMultiScenario({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      description: String(description).trim(),
      url: url ? String(url).trim() : null,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: Math.min(Math.max(Number(timeoutMs || 60000), 10000), 300000),
    });
    res.json(result);
  } catch (error) {
    console.error("Multi-scenario run failed:", error);
    res.status(400).json({ error: "Multi-scenario run failed", details: error.message });
  }
});

// Deep Exploration — Login → discover all modules → deep test each one with real DOM context
router.post("/tasks/:taskId/deep-explore", (req, res) => {
  const { instructions, timeoutMs } = req.body || {};
  if (!instructions || !String(instructions).trim()) {
    return res.status(400).json({ error: "instructions are required (include URL and credentials)" });
  }
  runAsync(
    ({ onRunCreated }) => runDeepExploration({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      instructions: String(instructions).trim(),
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: Math.min(Math.max(Number(timeoutMs || 300000), 30000), 600000),
      onRunCreated,
    }),
    res,
    "Deep exploration failed"
  );
});

router.get("/runs", async (req, res) => {
  try {
    const result = await listTestingAgentRuns({
      workspaceId: req.workspaceId,
      taskId: req.query.taskId || null,
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20),
      search: String(req.query.search || ""),
    });
    res.json(result);
  } catch (error) {
    console.error("Testing agent runs load failed:", error);
    res.status(500).json({ error: "Failed to load testing runs" });
  }
});

router.get("/runs/:runId", async (req, res) => {
  try {
    const run = await getTestingAgentRunById({
      workspaceId: req.workspaceId,
      runId: req.params.runId,
    });
    if (!run) {
      return res.status(404).json({ error: "Run not found" });
    }
    res.json(run);
  } catch (error) {
    console.error("Testing agent run detail load failed:", error);
    res.status(500).json({ error: "Failed to load run details" });
  }
});

export default router;
