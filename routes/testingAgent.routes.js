import express from "express";
import {
  autoDiscoverCliTests,
  generateTaskTestCases,
  generateAndSaveTestFile,
  getTestingAgentRunReport,
  getTestingAgentRunReportPdf,
  getTestingAgentRunById,
  getTestingAgentSettings,
  listTestingAgentProjectProfiles,
  listTestingAgentRuns,
  listTestingAgentTaskOptions,
  runApiTests,
  runCliMultiScenario,
  runTaskTests,
  stopTestingAgentRun,
  upsertTestingAgentProjectProfile,
  upsertTestingAgentSettings,
} from "../services/testingAgent.service.js";
import {
  runBrowserAgent,
  autoDiscoverAndTest,
  runMultiScenario,
  runDeepExploration,
  previewBrowserRun,
  previewAutoDiscoverRun,
  previewMultiScenarioRun,
  previewDeepExplorationRun,
} from "../services/browserAgent.service.js";
import {
  runSmartBrowserTest,
  provideRunCredentials,
} from "../services/smartBrowserTest.service.js";

const router = express.Router();

function canManage(user) {
  return user?.role === "admin" || user?.role === "manager";
}

function normalizeRequestedTimeout(timeoutMs, fallbackMs = 0) {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(parsed, fallbackMs);
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
      userId: req.user?.id || null,
      role: req.user?.role || null,
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

function buildDeepExploreInstructions(body = {}) {
  const {
    instructions,
    url,
    email,
    username,
    password,
  } = body || {};

  const lines = [];
  if (instructions && String(instructions).trim()) lines.push(String(instructions).trim());
  if (url && String(url).trim()) lines.push(`url: ${String(url).trim()}`);
  if ((email || username) && String(email || username).trim()) {
    lines.push(`email: ${String(email || username).trim()}`);
  }
  if (password && String(password).trim()) lines.push(`password: ${String(password).trim()}`);
  return lines.join("\n").trim();
}

// Smart browser test — DOM-first, no hallucination, live credential prompting
// Primary browser test endpoint: just give it a URL and it tests everything.
router.post("/tasks/:taskId/browser-run", (req, res) => {
  const { url, email, password, timeoutMs } = req.body || {};

  // Legacy path: if caller provides `instructions` (old API), extract URL from it
  let targetUrl = url ? String(url).trim() : null;
  if (!targetUrl) {
    const instructions = String(req.body?.instructions || "").trim();
    const match = instructions.match(/https?:\/\/[^\s,'"]+/);
    if (match) targetUrl = match[0];
  }

  if (!targetUrl || !targetUrl.startsWith("http")) {
    return res.status(400).json({ error: "url is required (e.g. { \"url\": \"https://myapp.com\" })" });
  }

  runAsync(
    ({ onRunCreated }) => runSmartBrowserTest({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      url: targetUrl,
      email: email ? String(email).trim() : null,
      password: password ? String(password).trim() : null,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: normalizeRequestedTimeout(timeoutMs, 10000),
      onRunCreated,
    }),
    res,
    "Browser test failed"
  );
});

// Provide credentials for a paused run (called by frontend when user submits the credential modal)
router.post("/runs/:runId/provide-credentials", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const result = await provideRunCredentials(
      req.params.runId,
      req.workspaceId,
      String(email).trim(),
      String(password).trim()
    );
    res.json(result);
  } catch (error) {
    console.error("Provide credentials failed:", error);
    res.status(400).json({ error: "Failed to provide credentials", details: error.message });
  }
});

// Legacy browser agent (kept for backward compatibility)
router.post("/tasks/:taskId/browser-run-legacy", (req, res) => {
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
      timeoutMs: normalizeRequestedTimeout(timeoutMs, 5000),
      onRunCreated,
    }),
    res,
    "Browser agent run failed"
  );
});

// Browser preview (kept as-is)
router.post("/tasks/:taskId/browser-preview", async (req, res) => {
  try {
    const { instructions } = req.body || {};
    const preview = await previewBrowserRun({
      instructions: String(instructions || "").trim(),
    });
    res.json(preview);
  } catch (error) {
    console.error("Browser agent preview failed:", error);
    res.status(400).json({ error: "Browser agent preview failed", details: error.message });
  }
});

// Auto-discover: give URL → AI explores page → builds & runs its own test plan
router.post("/tasks/:taskId/auto-discover-preview", async (req, res) => {
  try {
    const { url } = req.body || {};
    const preview = await previewAutoDiscoverRun({ url });
    res.json(preview);
  } catch (error) {
    console.error("Auto-discover preview failed:", error);
    res.status(400).json({ error: "Auto-discover preview failed", details: error.message });
  }
});

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
      timeoutMs: normalizeRequestedTimeout(timeoutMs, 10000),
      onRunCreated,
    }),
    res,
    "Auto-discover failed"
  );
});

// Multi-scenario: describe feature → AI generates 4 scenario types → runs them all
router.post("/tasks/:taskId/multi-scenario-preview", async (req, res) => {
  try {
    const { description, url } = req.body || {};
    const preview = await previewMultiScenarioRun({ description, url });
    res.json(preview);
  } catch (error) {
    console.error("Multi-scenario preview failed:", error);
    res.status(400).json({ error: "Multi-scenario preview failed", details: error.message });
  }
});

router.post("/tasks/:taskId/multi-scenario", (req, res) => {
  const { description, url, timeoutMs } = req.body || {};
  if (!description || String(description).trim().length < 5) {
    return res.status(400).json({ error: "description is required (min 5 characters)" });
  }
  runAsync(
    ({ onRunCreated }) => runMultiScenario({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      description: String(description).trim(),
      url: url ? String(url).trim() : null,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: normalizeRequestedTimeout(timeoutMs, 10000),
      onRunCreated,
    }),
    res,
    "Multi-scenario run failed"
  );
});

// Deep Exploration — Login → discover all modules → deep test each one with real DOM context
router.post("/tasks/:taskId/deep-explore-preview", async (req, res) => {
  try {
    const deepInstructions = buildDeepExploreInstructions(req.body || {});
    const preview = await previewDeepExplorationRun({ instructions: deepInstructions });
    res.json(preview);
  } catch (error) {
    console.error("Deep exploration preview failed:", error);
    res.status(400).json({ error: "Deep exploration preview failed", details: error.message });
  }
});

router.post("/tasks/:taskId/deep-explore", (req, res) => {
  const { timeoutMs } = req.body || {};
  const deepInstructions = buildDeepExploreInstructions(req.body || {});
  if (!deepInstructions) {
    return res.status(400).json({ error: "Provide instructions or at least url plus credentials" });
  }
  runAsync(
    ({ onRunCreated }) => runDeepExploration({
      workspaceId: req.workspaceId,
      taskId: req.params.taskId,
      instructions: deepInstructions,
      triggeredBy: req.user?.id || null,
      triggerSource: "manual",
      timeoutMs: normalizeRequestedTimeout(timeoutMs, 30000),
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
      userId: req.user?.id || null,
      role: req.user?.role || null,
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

router.post("/runs/:runId/stop", async (req, res) => {
  try {
    const run = await stopTestingAgentRun({
      workspaceId: req.workspaceId,
      runId: req.params.runId,
      actorId: req.user?.id || null,
      reason: String(req.body?.reason || "Stopped by user"),
    });
    if (!run) {
      return res.status(404).json({ error: "Run not found" });
    }
    res.json({
      runId: run.id,
      status: run.status,
      cancelControl: run.output_json?.cancelControl || null,
    });
  } catch (error) {
    console.error("Testing agent stop failed:", error);
    res.status(500).json({ error: "Failed to stop run" });
  }
});

router.get("/runs/:runId/report", async (req, res) => {
  try {
    const report = await getTestingAgentRunReport({
      workspaceId: req.workspaceId,
      runId: req.params.runId,
    });
    if (!report) {
      return res.status(404).json({ error: "Run not found" });
    }
    res.json(report);
  } catch (error) {
    console.error("Testing agent run report load failed:", error);
    res.status(500).json({ error: "Failed to load run report" });
  }
});

router.get("/runs/:runId/report.pdf", async (req, res) => {
  try {
    const report = await getTestingAgentRunReportPdf({
      workspaceId: req.workspaceId,
      runId: req.params.runId,
    });
    if (!report) {
      return res.status(404).json({ error: "Run not found" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
    res.send(report.buffer);
  } catch (error) {
    console.error("Testing agent PDF export failed:", error);
    res.status(500).json({ error: "Failed to export run report" });
  }
});

export default router;
