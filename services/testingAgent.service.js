import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";

const DEFAULT_SETTINGS = {
  enabled: true,
  auto_generate_on_git: true,
  auto_run_on_git: false,
  max_runtime_seconds: 900,
  test_commands: [],
};

function normalizeCommands(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function truncateText(str = "", max = 8000) {
  const s = String(str || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-fA-F-]{36}$/.test(v);
}

// ─────────────────────────────────────────────────────────
// PARSE JSON SAFE
// ─────────────────────────────────────────────────────────
function parseJsonSafe(raw, fallback = null) {
  try {
    let s = String(raw || "").trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    const isArr = s.indexOf("[") !== -1 && (s.indexOf("[") < (s.indexOf("{") === -1 ? Infinity : s.indexOf("{")));
    const open = isArr ? "[" : "{";
    const close = isArr ? "]" : "}";
    const start = s.indexOf(open);
    const end = s.lastIndexOf(close);
    if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────
// LIVE DB UPDATE — writes partial output as commands complete
// Same pattern as browserAgent.updateRunLive
// ─────────────────────────────────────────────────────────
async function updateRunLive(runId, partialOutput) {
  try {
    await pool.query(
      `UPDATE testing_agent_runs
       SET output_json = jsonb_set(COALESCE(output_json,'{}'), '{commandOutputs}', $2::jsonb)
       WHERE id = $1`,
      [runId, JSON.stringify(partialOutput)]
    );
  } catch (err) {
    console.warn("[testingAgent] Live update failed:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// AI FAILURE ANALYSIS — explains WHY a CLI test failed
// ─────────────────────────────────────────────────────────
async function aiAnalyzeCliFailure(command, stdout, stderr, framework) {
  const errorText = `${stderr}\n${stdout}`.slice(0, 600);
  const prompt = `A ${framework || "CLI"} test command failed. Explain why in 2-3 sentences and what to fix.
Command: ${command}
Output: ${errorText}
Plain text only. Be specific about the root cause.`;
  try {
    const raw = await generateText({ prompt, maxTokens: 220 });
    return String(raw || "").trim() || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// POST-RUN INSIGHTS — AI analysis of overall run result
// Returns same structure as browserAgent.generateRunInsights
// ─────────────────────────────────────────────────────────
async function generateCliRunInsights(commandOutputs, generatedCases, mode = "cli") {
  const passed = commandOutputs.filter((c) => c.passed).length;
  const failed = commandOutputs.filter((c) => !c.passed && !c.timedOut).length;
  const timedOut = commandOutputs.filter((c) => c.timedOut).length;
  const defaultInsights = {
    verdict: failed + timedOut > 0 ? (passed === 0 ? "Critical failure" : "Some tests failed") : "All tests passed",
    whatWorked: commandOutputs.filter((c) => c.passed).map((c) => c.command).slice(0, 4),
    whatFailed: commandOutputs.filter((c) => !c.passed).map((c) => `${c.command}${c.timedOut ? " (timed out)" : ""}`).slice(0, 4),
    rootCause: null,
    recommendations: [],
    nextTestsToRun: [],
    performanceNote: commandOutputs.length > 0
      ? `Total execution: ${commandOutputs.reduce((s, c) => s + (c.durationMs || 0), 0)}ms`
      : null,
  };
  try {
    const failedSummary = commandOutputs.filter((c) => !c.passed)
      .map((c) => `${c.command}: ${(c.stderr || c.stdout || "").slice(0, 150)}`)
      .join("; ").slice(0, 500);
    const passedNames = commandOutputs.filter((c) => c.passed).map((c) => c.command).join(", ").slice(0, 200);
    const casesSummary = Array.isArray(generatedCases)
      ? generatedCases.slice(0, 4).map((c) => c.title).join(", ")
      : "";
    const prompt = `CLI test run (${mode}): ${passed} passed, ${failed} failed, ${timedOut} timed out of ${commandOutputs.length} commands.
Passed: ${passedNames || "none"}. Failed: ${failedSummary || "none"}.
Test cases: ${casesSummary}.
Return JSON only (no markdown):
{"verdict":"All tests passed|Some tests failed|Critical failure","whatWorked":["..."],"whatFailed":["..."],"rootCause":"...or null","recommendations":["..."],"nextTestsToRun":["..."],"performanceNote":"...or null"}`;
    const raw = await generateText({ prompt, maxTokens: 500 });
    const parsed = parseJsonSafe(raw, null);
    if (parsed && typeof parsed === "object") return { ...defaultInsights, ...parsed };
  } catch { /* fall through */ }
  return defaultInsights;
}

// ─────────────────────────────────────────────────────────
// READ CHANGED FILES — reads actual source code for richer test generation
// ─────────────────────────────────────────────────────────
function readChangedFiles(repoPath, changedFiles = []) {
  if (!repoPath || !isDirectory(repoPath)) return {};
  const contents = {};
  const interesting = changedFiles
    .filter((f) => /\.[jt]sx?$|\.(py|go|java|rb|php|cs|rs|swift)$/i.test(f))
    .slice(0, 4); // max 4 files to stay within LLM budget
  for (const relPath of interesting) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(repoPath, relPath);
    try {
      const content = fs.readFileSync(absPath, "utf8").slice(0, 1200); // first 1200 chars
      contents[relPath] = content;
    } catch { /* file not readable — skip */ }
  }
  return contents;
}

function tokenize(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9/_\-\s]+/g, " ")
    .split(/[\s/_\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

async function getTaskContext(workspaceId, taskId) {
  const { rows } = await pool.query(
    `
    SELECT
      t.id,
      t.task,
      t.description,
      t.status,
      t.priority,
      t.project_id,
      t.ticket_number,
      p.name AS project_name,
      p.project_code,
      u.username AS assignee_username
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.id = $1
      AND t.workspace_id = $2
    LIMIT 1
    `,
    [taskId, workspaceId]
  );
  return rows[0] || null;
}

function parseJsonMaybe(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function getGitContextForTask(workspaceId, task) {
  const taskKey = task?.project_code && task?.ticket_number
    ? `${String(task.project_code).toUpperCase()}-${task.ticket_number}`
    : null;

  const { rows } = await pool.query(
    `
    SELECT result_json, payload_json, created_at
    FROM git_automation_events
    WHERE workspace_id = $1
    ORDER BY created_at DESC
    LIMIT 120
    `,
    [workspaceId]
  );

  for (const row of rows) {
    const result = parseJsonMaybe(row.result_json, {});
    const payload = parseJsonMaybe(row.payload_json, {});
    const applied = Array.isArray(result?.applied) ? result.applied : [];
    const hit = applied.find((a) =>
      (taskKey && String(a?.taskKey || "").toUpperCase() === taskKey) ||
      String(a?.taskName || "").trim().toLowerCase() === String(task?.task || "").trim().toLowerCase()
    );
    if (!hit) continue;

    return {
      matchedAt: row.created_at,
      taskKey,
      changedFiles: Array.isArray(payload?.changedFiles) ? payload.changedFiles.slice(0, 300) : [],
      branch: payload?.branch || null,
      confidence: hit?.confidence ?? null,
      inferred: Boolean(hit?.inferred),
    };
  }

  return {
    matchedAt: null,
    taskKey,
    changedFiles: [],
    branch: null,
    confidence: null,
    inferred: false,
  };
}

async function buildTestCasesWithLLM({ task, gitContext, fileContents = {}, framework = "unknown" }) {
  const taskTitle = task?.task || "";
  const taskDesc = (task?.description || "").slice(0, 300);
  const changedFiles = Array.isArray(gitContext?.changedFiles) ? gitContext.changedFiles.slice(0, 12).join(", ") : "";
  const codeSnippets = Object.entries(fileContents).slice(0, 2)
    .map(([f, c]) => `// ${f}\n${c.slice(0, 500)}`).join("\n\n");

  const prompt = `You are a senior QA engineer. Generate 8-12 specific, runnable test cases for this task.

TASK: "${taskTitle}"
${taskDesc ? `DESC: "${taskDesc}"` : ""}
${changedFiles ? `CHANGED FILES: ${changedFiles}` : ""}
${codeSnippets ? `CODE CONTEXT:\n${codeSnippets}` : ""}
FRAMEWORK: ${framework}

Generate test cases covering ALL these levels (use as many as relevant):
- unit: individual function/method behavior
- integration: how components interact
- e2e: end-to-end user flow
- edge: boundary values, empty inputs, overflow, null handling
- security: auth bypass, injection, sensitive data exposure
- performance: response time, load handling
- regression: ensure existing behavior still works

Each test case MUST include:
- "codeSnippet": actual runnable test code in ${framework} syntax (not pseudocode, real assertions)

Return ONLY this JSON array (no markdown):
[{"id":"TC-001","level":"unit","title":"...specific to task...","objective":"...","steps":["...","..."],"expected":["..."],"codeSnippet":"// actual test code here"},...]

Rules:
- titles/steps MUST be specific to "${taskTitle}" — no generic placeholders
- codeSnippet must use the right assertion syntax for ${framework} (expect/assert/etc.)
- Cover happy path, error cases, and edge cases
- Return ONLY the JSON array`;

  try {
    const raw = await generateText({ prompt, maxTokens: 3000 });
    const cases = parseJsonSafe(raw, null);
    if (Array.isArray(cases) && cases.length > 0) {
      return cases.slice(0, 15).map((c, i) => ({
        ...c,
        id: `TC-${String(i + 1).padStart(3, "0")}`,
      }));
    }
  } catch (err) {
    console.error("Enhanced LLM test case generation failed:", err.message);
  }

  return buildTestCasesFallback({ task, gitContext });
}

function buildTestCasesFallback({ task, gitContext }) {
  const taskText = `${task?.task || ""} ${task?.description || ""}`;
  const tokens = new Set(tokenize(taskText));
  const files = Array.isArray(gitContext?.changedFiles) ? gitContext.changedFiles : [];
  const hasApi = files.some((f) => /api|route|controller|service/i.test(f));
  const hasUi = files.some((f) => /src\/pages|src\/components|ui|view/i.test(f));
  const hasAuth = tokens.has("auth") || tokens.has("login") || tokens.has("password");
  const hasPayment = tokens.has("payment") || tokens.has("invoice") || tokens.has("billing");

  const cases = [];
  let idx = 1;
  const add = (level, title, objective, steps, expected) =>
    cases.push({ id: `TC-${String(idx++).padStart(3, "0")}`, level, title, objective, steps, expected });

  add("basic", `Happy path: ${task.task}`,
    `Validate primary behavior for "${task.task}".`,
    ["Set up valid initial state", "Perform the main action", "Verify the expected outcome"],
    ["No errors thrown", "Expected result is correct", "State is persisted properly"]
  );
  add("functional", "Input validation",
    "Ensure invalid and boundary inputs are rejected gracefully.",
    ["Submit empty/invalid input", "Submit boundary values", "Submit unexpected data types"],
    ["Invalid input is rejected with clear error", "No crash on boundary values"]
  );
  if (hasApi) add("integration", "API contract", "Verify endpoint contract and side effects.",
    ["Call with valid payload", "Call with missing required fields", "Check DB state after call"],
    ["Correct HTTP status and response shape", "No unhandled exceptions", "Data integrity preserved"]
  );
  if (hasUi) add("ui", "UI interaction", "Validate UI states, feedback, and error messages.",
    ["Trigger the UI action", "Trigger a recoverable error state", "Check responsive layout"],
    ["Correct UI state shown", "Error messages are clear", "No broken layout"]
  );
  if (hasAuth) add("edge", "Auth edge cases", "Ensure auth-sensitive paths are secure.",
    ["Try unauthenticated access", "Try with expired token", "Try with insufficient role"],
    ["Access denied where expected", "No sensitive data leaked"]
  );
  if (hasPayment) add("edge", "Payment idempotency", "Ensure payment operations are safe against retries.",
    ["Trigger duplicate payment request", "Simulate partial failure mid-flow"],
    ["No duplicate charges", "System recovers to consistent state"]
  );
  add("regression", "Regression guard", "Ensure existing behavior around this area stays stable.",
    ["Run related module tests", "Execute cross-module workflow involving this change"],
    ["No regression in related modules", "No new warnings in logs"]
  );

  return cases.slice(0, 20);
}

// ─────────────────────────────────────────────────────────
// GENERATE TEST CODE — creates actual test file content for the framework
// ─────────────────────────────────────────────────────────
async function generateTestCode({ task, cases, framework, fileContents = {} }) {
  const taskTitle = task?.task || "feature";
  const codeSnippets = Object.entries(fileContents).slice(0, 2)
    .map(([f, c]) => `// ${f}\n${c.slice(0, 600)}`).join("\n\n");

  const frameworkTemplates = {
    node: { ext: "test.js", runner: "jest/vitest", import: "import { describe, it, expect } from 'vitest';" },
    python: { ext: "test_.py", runner: "pytest", import: "import pytest" },
    go: { ext: "_test.go", runner: "go test", import: 'import "testing"' },
    maven: { ext: "Test.java", runner: "JUnit", import: "import org.junit.jupiter.api.Test;" },
    gradle: { ext: "Test.java", runner: "JUnit", import: "import org.junit.jupiter.api.Test;" },
  };
  const tmpl = frameworkTemplates[framework] || frameworkTemplates.node;
  const casesSummary = cases.slice(0, 6).map((c) => `- ${c.title}: ${c.objective}`).join("\n");
  const existingCode = codeSnippets ? `\nEXISTING CODE:\n${codeSnippets}` : "";

  const prompt = `Write a complete, runnable ${tmpl.runner} test file for:

FEATURE: "${taskTitle}"
TEST CASES:
${casesSummary}
${existingCode}

Rules:
- Use ${tmpl.runner} syntax and ${tmpl.import} import style
- Include describe/test/it blocks
- Use realistic test data specific to "${taskTitle}"
- Add proper setup/teardown if needed
- Include at least 6 test cases covering happy path, edge cases, and errors
- Return ONLY the test file code, no explanation`;

  try {
    const code = String(await generateText({ prompt, maxTokens: 2500 })).trim()
      .replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
    return {
      code,
      filename: `${String(taskTitle).toLowerCase().replace(/[^a-z0-9]+/g, "_")}.${tmpl.ext}`,
      framework: tmpl.runner,
    };
  } catch (err) {
    return { code: null, filename: null, framework: tmpl.runner, error: err.message };
  }
}

function inferDefaultCommands(gitContext) {
  const files = Array.isArray(gitContext?.changedFiles) ? gitContext.changedFiles : [];
  const hasPy = files.some((f) => /\.py$/i.test(f));
  const hasGo = files.some((f) => /\.go$/i.test(f));
  const hasJava = files.some((f) => /\.java$/i.test(f) || /pom\.xml$/i.test(f));
  const hasJsTs = files.some((f) => /\.[jt]sx?$/i.test(f) || /package\.json$/i.test(f));

  if (hasPy) return ["pytest -q"];
  if (hasGo) return ["go test ./..."];
  if (hasJava) return ["mvn -q test"];
  if (hasJsTs) return ["npm test -- --runInBand"];
  return ["npm test -- --runInBand"];
}

// onProgress(liveStdout) is called every ~20 lines with accumulated output so far
function executeCommand(command, timeoutSec, cwd = null, onProgress = null) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      shell: true,
      env: process.env,
      cwd: cwd || process.env.TESTING_AGENT_WORKDIR || process.cwd(),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let lineCount = 0;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, Math.max(10, Number(timeoutSec || 900)) * 1000);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (onProgress) {
        lineCount += (d.toString().match(/\n/g) || []).length;
        if (lineCount % 20 === 0) onProgress(truncateText(stdout, 4000));
      }
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: Number(code ?? -1),
        passed: !killed && Number(code ?? 1) === 0,
        timedOut: killed,
        durationMs: Date.now() - startedAt,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr),
      });
    });
  });
}

// TRANSIENT ERROR DETECTION — returns true if failure looks retryable
function isTransientFailure(output) {
  const text = `${output.stderr}\n${output.stdout}`.toLowerCase();
  return output.timedOut || [
    "econnrefused", "econnreset", "etimedout", "socket hang up",
    "network error", "connection refused", "temporarily unavailable",
    "resource temporarily unavailable", "address already in use",
  ].some((k) => text.includes(k));
}

// EXECUTE WITH RETRY — retries once on transient failures
async function executeCommandWithRetry(command, timeoutSec, cwd, onProgress = null) {
  const result = await executeCommand(command, timeoutSec, cwd, onProgress);
  if (!result.passed && isTransientFailure(result)) {
    console.warn(`[testingAgent] Retrying "${command}" after transient failure`);
    await new Promise((r) => setTimeout(r, 2000)); // 2s backoff
    const retry = await executeCommand(command, timeoutSec, cwd, onProgress);
    return { ...retry, retried: true, firstAttemptError: result.stderr?.slice(0, 200) };
  }
  return result;
}

function classifyFailure(outputs = []) {
  const text = outputs
    .map((o) => `${o?.stderr || ""}\n${o?.stdout || ""}`.toLowerCase())
    .join("\n");

  const configIndicators = [
    "missing script: \"test\"",
    "missing script: test",
    "command not found",
    "is not recognized as an internal or external command",
    "no such file or directory",
    "cannot find module",
    "not installed",
  ];

  if (configIndicators.some((k) => text.includes(k))) {
    return {
      status: "blocked",
      reason: "Test command is not configured/runnable in current backend environment",
    };
  }

  return {
    status: "failed",
    reason: "Test execution failed",
  };
}

function isDirectory(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function detectFramework(repoPath) {
  if (!isDirectory(repoPath)) return { framework: "unknown", recommendedCommands: [] };

  const packageJsonPath = path.join(repoPath, "package.json");
  if (fileExists(packageJsonPath)) {
    const pkg = readJsonFileSafe(packageJsonPath);
    const scripts = pkg?.scripts || {};
    const hasTestScript = Boolean(scripts.test);
    const hasVitest = Boolean(scripts.vitest || scripts["test:unit"]);
    const hasPlaywright = Boolean(scripts["test:e2e"]);
    const commands = [];
    if (hasTestScript) commands.push("npm test -- --runInBand");
    if (hasVitest) commands.push("npm run test:unit");
    if (hasPlaywright) commands.push("npm run test:e2e");
    return {
      framework: "node",
      recommendedCommands: commands.length ? commands : ["npm test -- --runInBand"],
    };
  }

  if (
    fileExists(path.join(repoPath, "pytest.ini")) ||
    fileExists(path.join(repoPath, "pyproject.toml")) ||
    fileExists(path.join(repoPath, "requirements.txt"))
  ) {
    return { framework: "python", recommendedCommands: ["pytest -q"] };
  }

  if (fileExists(path.join(repoPath, "go.mod"))) {
    return { framework: "go", recommendedCommands: ["go test ./..."] };
  }

  if (fileExists(path.join(repoPath, "pom.xml"))) {
    return { framework: "maven", recommendedCommands: ["mvn -q test"] };
  }

  if (fileExists(path.join(repoPath, "gradlew.bat")) || fileExists(path.join(repoPath, "build.gradle"))) {
    return { framework: "gradle", recommendedCommands: ["gradlew.bat test"] };
  }

  return { framework: "unknown", recommendedCommands: [] };
}

function slugify(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveRepoName(repoFullName = "") {
  const input = String(repoFullName || "").trim();
  if (!input) return null;
  const last = input.split("/").pop();
  return last || null;
}

function findRepoCandidates({ repoFullName, projectName }) {
  const names = new Set();
  const repoName = deriveRepoName(repoFullName);
  if (repoName) names.add(repoName);
  const projectSlug = slugify(projectName);
  if (projectSlug) {
    names.add(projectSlug);
    names.add(projectSlug.replace(/-/g, "_"));
  }

  // Only look in roots that are specifically configured for repos,
  // NOT in process.cwd() itself - we don't want to silently run tests
  // in the backend server directory when no profile is configured.
  const roots = [
    process.env.TESTING_AGENT_REPOS_ROOT || null,
    process.env.TESTING_AGENT_WORKDIR || null,
    // Only include cwd's PARENT as a root for named subdirs, not cwd itself
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
  ].filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    if (!isDirectory(root)) continue;
    // Only add named subdirectories, never the root itself
    for (const n of names) {
      const candidate = path.join(root, n);
      if (isDirectory(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return Array.from(new Set(candidates));
}

async function getProjectProfile(workspaceId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      p.project_code,
      g.repo_full_name,
      tp.repo_path,
      tp.framework,
      tp.commands,
      tp.enabled AS profile_enabled
    FROM projects p
    LEFT JOIN git_project_automation_settings g
      ON g.workspace_id = p.workspace_id
      AND g.project_id = p.id
    LEFT JOIN testing_agent_project_profiles tp
      ON tp.workspace_id = p.workspace_id
      AND tp.project_id = p.id
    WHERE p.workspace_id = $1
      AND p.id = $2
    LIMIT 1
    `,
    [workspaceId, projectId]
  );
  return rows[0] || null;
}

async function resolveExecutionContext({ workspaceId, task, workspaceSettings }) {
  const profile = await getProjectProfile(workspaceId, task.project_id);
  const explicitRepoPath = isNonEmptyString(profile?.repo_path) ? path.resolve(profile.repo_path) : null;

  let repoPath = explicitRepoPath;
  if (!repoPath || !isDirectory(repoPath)) {
    const candidates = findRepoCandidates({
      repoFullName: profile?.repo_full_name || "",
      projectName: profile?.project_name || task?.project_name || "",
    });
    repoPath = candidates.find((p) => isDirectory(p)) || null;
  }

  const detected = repoPath ? detectFramework(repoPath) : { framework: "unknown", recommendedCommands: [] };
  const profileCommands = normalizeCommands(parseJsonMaybe(profile?.commands, []));
  // Only use workspace-level commands if they look like actual test commands
  const workspaceCommandsRaw = normalizeCommands(workspaceSettings?.test_commands || []);
  const testCommandPattern = /\b(test|pytest|jest|vitest|mocha|jasmine|karma|go\s+test|mvn|gradle|rspec|phpunit|dotnet\s+test)\b/i;
  const workspaceCommands = workspaceCommandsRaw.filter((c) => testCommandPattern.test(c));
  const finalCommands = profileCommands.length
    ? profileCommands
    : workspaceCommands.length
      ? workspaceCommands
      : detected.recommendedCommands.length
        ? detected.recommendedCommands
        : inferDefaultCommands({ changedFiles: [] });

  return {
    projectId: task.project_id,
    projectName: profile?.project_name || task.project_name || null,
    projectCode: profile?.project_code || task.project_code || null,
    repoFullName: profile?.repo_full_name || null,
    repoPath,
    framework: profile?.framework || detected.framework || "unknown",
    commands: finalCommands,
  };
}

async function ensureSettingsRow(workspaceId) {
  const { rows } = await pool.query(
    `
    INSERT INTO testing_agent_settings (workspace_id)
    VALUES ($1)
    ON CONFLICT (workspace_id) DO NOTHING
    RETURNING *
    `,
    [workspaceId]
  );
  if (rows[0]) return rows[0];
  const { rows: existing } = await pool.query(
    `SELECT * FROM testing_agent_settings WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId]
  );
  return existing[0];
}

export async function getTestingAgentSettings(workspaceId) {
  const row = await ensureSettingsRow(workspaceId);
  return {
    ...DEFAULT_SETTINGS,
    ...row,
    test_commands: normalizeCommands(parseJsonMaybe(row?.test_commands, [])),
  };
}

export async function upsertTestingAgentSettings({
  workspaceId,
  enabled,
  autoGenerateOnGit,
  autoRunOnGit,
  maxRuntimeSeconds,
  testCommands,
  actorId,
}) {
  const commands = normalizeCommands(testCommands);
  const { rows } = await pool.query(
    `
    INSERT INTO testing_agent_settings (
      workspace_id,
      enabled,
      auto_generate_on_git,
      auto_run_on_git,
      max_runtime_seconds,
      test_commands,
      created_by,
      updated_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (workspace_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      auto_generate_on_git = EXCLUDED.auto_generate_on_git,
      auto_run_on_git = EXCLUDED.auto_run_on_git,
      max_runtime_seconds = EXCLUDED.max_runtime_seconds,
      test_commands = EXCLUDED.test_commands,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
    `,
    [
      workspaceId,
      enabled !== false,
      autoGenerateOnGit !== false,
      Boolean(autoRunOnGit),
      Math.min(3600, Math.max(30, Number(maxRuntimeSeconds || 900))),
      JSON.stringify(commands),
      actorId || null,
    ]
  );

  return {
    ...rows[0],
    test_commands: normalizeCommands(parseJsonMaybe(rows[0]?.test_commands, [])),
  };
}

async function createRun({
  workspaceId,
  projectId,
  taskId,
  triggerSource,
  mode,
  createdBy,
  generatedCases = [],
  commands = [],
  status = "pending",
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO testing_agent_runs (
      workspace_id,
      project_id,
      task_id,
      trigger_source,
      mode,
      status,
      generated_cases,
      commands,
      output_json,
      created_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
    `,
    [
      workspaceId,
      projectId,
      taskId,
      triggerSource || "manual",
      mode || "run",
      status,
      JSON.stringify(generatedCases),
      JSON.stringify(commands),
      JSON.stringify({}),
      createdBy || null,
    ]
  );
  return rows[0];
}

async function finishRun(runId, { status, outputJson }) {
  const { rows } = await pool.query(
    `
    UPDATE testing_agent_runs
    SET
      status = $2,
      output_json = $3,
      finished_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [runId, status, JSON.stringify(outputJson || {})]
  );
  return rows[0];
}

export async function generateTaskTestCases({
  workspaceId,
  taskId,
  triggeredBy = null,
  triggerSource = "manual",
}) {
  if (!isUuid(taskId)) throw new Error("Invalid taskId");
  const task = await getTaskContext(workspaceId, taskId);
  if (!task) throw new Error("Task not found in workspace");

  const settings = await getTestingAgentSettings(workspaceId);
  const gitContext = await getGitContextForTask(workspaceId, task);

  // Resolve execution context to get framework + repo path for file reading
  const executionContext = await resolveExecutionContext({ workspaceId, task, workspaceSettings: settings });
  const fileContents = readChangedFiles(executionContext.repoPath, gitContext?.changedFiles || []);

  // Use full enhanced generation with file context + framework
  const generatedCases = await buildTestCasesWithLLM({
    task,
    gitContext,
    fileContents,
    framework: executionContext.framework,
  });

  // Also generate actual test code
  const testFile = await generateTestCode({
    task,
    cases: generatedCases,
    framework: executionContext.framework,
    fileContents,
  }).catch(() => null);

  const run = await createRun({
    workspaceId,
    projectId: task.project_id,
    taskId,
    triggerSource,
    mode: "generate",
    createdBy: triggeredBy,
    generatedCases,
    commands: [],
    status: "generated",
  });

  await finishRun(run.id, {
    status: "generated",
    outputJson: { generatedCases, testFile, gitContext, framework: executionContext.framework },
  });

  return {
    runId: run.id,
    task: {
      id: task.id,
      name: task.task,
      projectId: task.project_id,
      projectName: task.project_name,
      taskKey: task.project_code && task.ticket_number ? `${task.project_code}-${task.ticket_number}` : null,
    },
    gitContext,
    generatedCases,
    testFile,
    framework: executionContext.framework,
  };
}

export async function runTaskTests({
  workspaceId,
  taskId,
  triggeredBy = null,
  triggerSource = "manual",
  stopOnFirstFailure = false,   // NEW: run all commands by default
  generateCode = false,          // NEW: also generate test file
}) {
  if (!isUuid(taskId)) throw new Error("Invalid taskId");
  const task = await getTaskContext(workspaceId, taskId);
  if (!task) throw new Error("Task not found in workspace");

  const settings = await getTestingAgentSettings(workspaceId);
  if (!settings.enabled) {
    throw new Error("Testing agent is disabled for this workspace");
  }

  const gitContext = await getGitContextForTask(workspaceId, task);
  const executionContext = await resolveExecutionContext({
    workspaceId,
    task,
    workspaceSettings: settings,
  });

  // Read changed file contents for richer test generation
  const fileContents = readChangedFiles(
    executionContext.repoPath,
    gitContext?.changedFiles || []
  );

  // Generate enhanced test cases
  const generatedCases = await buildTestCasesWithLLM({
    task,
    gitContext,
    fileContents,
    framework: executionContext.framework,
  });

  const finalCommands = executionContext.commands;

  if (!executionContext.repoPath) {
    throw new Error(
      `No repository path configured for project "${executionContext.projectName || task.project_name || "this project"}". ` +
      `Go to Testing Agent → Project Execution Profiles, set the repo path and test commands, then try again.`
    );
  }

  const run = await createRun({
    workspaceId,
    projectId: task.project_id,
    taskId,
    triggerSource,
    mode: "run",
    createdBy: triggeredBy,
    generatedCases,
    commands: finalCommands,
    status: "running",
  });

  // Execute commands with live updates + streaming + retry + per-command AI analysis
  const commandOutputs = [];
  for (const cmd of finalCommands) {
    const output = await executeCommandWithRetry(
      cmd,
      settings.max_runtime_seconds,
      executionContext.repoPath,
      async (liveStdout) => {
        // Stream stdout to DB as lines arrive (~every 20 lines)
        await updateRunLive(run.id, [
          ...commandOutputs,
          { command: cmd, status: "running", stdout: liveStdout, stderr: "", passed: false, timedOut: false, durationMs: 0 },
        ]);
      }
    );

    // AI failure analysis for failed commands
    if (!output.passed) {
      output.aiAnalysis = await aiAnalyzeCliFailure(
        cmd, output.stdout, output.stderr, executionContext.framework
      );
    }

    commandOutputs.push(output);
    // Live update after each command (frontend can poll and see progress)
    await updateRunLive(run.id, commandOutputs);

    if (stopOnFirstFailure && !output.passed) break;
  }

  const passed = commandOutputs.length > 0 && commandOutputs.every((c) => c.passed);
  const failureInfo = passed ? null : classifyFailure(commandOutputs);

  // Generate AI post-run insights
  const insights = await generateCliRunInsights(commandOutputs, generatedCases, "cli");

  // Optionally generate test code
  let testCode = null;
  if (generateCode || (fileContents && Object.keys(fileContents).length > 0)) {
    testCode = await generateTestCode({
      task,
      cases: generatedCases,
      framework: executionContext.framework,
      fileContents,
    }).catch(() => null);
  }

  const outputJson = {
    gitContext,
    summary: {
      commandCount: finalCommands.length,
      executedCount: commandOutputs.length,
      passed,
      failureReason: failureInfo?.reason || null,
    },
    executionContext,
    commandOutputs,
    insights,
    testCode,
  };

  const finished = await finishRun(run.id, {
    status: passed ? "passed" : failureInfo?.status || "failed",
    outputJson,
  });

  return {
    runId: finished.id,
    status: finished.status,
    generatedCases,
    commands: finalCommands,
    insights,
    testCode,
    output: parseJsonMaybe(finished.output_json, {}),
  };
}

// ─────────────────────────────────────────────────────────
// API TESTING — LLM generates HTTP test scenarios, executes them,
// validates responses, provides AI analysis
// ─────────────────────────────────────────────────────────
async function generateApiTestPlan(task, baseUrl, openApiSpec = null) {
  const taskTitle = task?.task || "";
  const specContext = openApiSpec ? `API Spec (partial): ${JSON.stringify(openApiSpec).slice(0, 800)}` : "";
  const prompt = `QA engineer. Generate 6-10 HTTP API test scenarios for this task.

TASK: "${taskTitle}"
BASE URL: ${baseUrl}
${specContext}

Return ONLY this JSON array:
[{"id":"AT-001","name":"...","method":"GET|POST|PUT|DELETE|PATCH","path":"/api/...","headers":{},"body":null,"expectedStatus":200,"expectedFields":["field1","field2"],"description":"..."},...]

Rules:
- Cover: happy path, validation errors (400), auth errors (401/403), not found (404), server errors (500)
- body should be a JSON object (or null for GET)
- expectedFields: top-level fields expected in JSON response
- paths must be realistic for "${taskTitle}"
Return ONLY the JSON array.`;

  try {
    const raw = await generateText({ prompt, maxTokens: 2000 });
    const plan = parseJsonSafe(raw, null);
    if (Array.isArray(plan) && plan.length > 0) return plan.slice(0, 10);
  } catch { /* fallback */ }

  return [
    { id: "AT-001", name: "GET root health check", method: "GET", path: "/health", headers: {}, body: null, expectedStatus: 200, expectedFields: [], description: "API is reachable" },
    { id: "AT-002", name: "GET main resource", method: "GET", path: "/api", headers: {}, body: null, expectedStatus: 200, expectedFields: [], description: "API responds" },
  ];
}

async function executeApiStep(step, baseUrl, authToken = null) {
  const t0 = Date.now();
  const url = `${baseUrl.replace(/\/$/, "")}${step.path}`;
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
    ...(step.headers || {}),
  };
  const result = {
    id: step.id,
    name: step.name,
    method: step.method,
    url,
    expectedStatus: step.expectedStatus,
    status: "passed",
    actualStatus: null,
    responseBody: null,
    durationMs: 0,
    error: null,
    aiAnalysis: null,
    checks: [],
  };

  try {
    const fetchOptions = {
      method: step.method || "GET",
      headers,
    };
    if (step.body && step.method !== "GET") {
      fetchOptions.body = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timeout);

    result.actualStatus = res.status;
    let responseData = null;
    try {
      responseData = await res.json();
      result.responseBody = JSON.stringify(responseData).slice(0, 800);
    } catch {
      result.responseBody = await res.text().then((t) => t.slice(0, 800)).catch(() => "");
    }

    // Status code check
    const statusOk = result.actualStatus === step.expectedStatus;
    result.checks.push({ check: `Status ${step.expectedStatus}`, passed: statusOk, actual: result.actualStatus });
    if (!statusOk) result.status = "failed";

    // Expected fields check
    if (Array.isArray(step.expectedFields) && step.expectedFields.length > 0 && responseData) {
      for (const field of step.expectedFields) {
        const present = field in (responseData || {});
        result.checks.push({ check: `Field "${field}" present`, passed: present });
        if (!present) result.status = "failed";
      }
    }

    if (result.status === "failed") {
      result.aiAnalysis = await aiAnalyzeCliFailure(
        `${step.method} ${url}`,
        result.responseBody || "",
        `Expected status ${step.expectedStatus}, got ${result.actualStatus}`,
        "HTTP API"
      );
    }
  } catch (err) {
    result.status = "failed";
    result.error = err.message?.slice(0, 200) || "Request failed";
    result.aiAnalysis = await aiAnalyzeCliFailure(`${step.method} ${url}`, "", err.message, "HTTP API");
  }

  result.durationMs = Date.now() - t0;
  return result;
}

export async function runApiTests({
  workspaceId,
  taskId,
  baseUrl,
  authToken = null,
  openApiSpec = null,
  triggeredBy = null,
  triggerSource = "manual",
}) {
  if (!baseUrl || !String(baseUrl).trim().startsWith("http")) {
    throw new Error("A valid HTTP base URL is required");
  }

  if (!isUuid(taskId)) throw new Error("Invalid taskId");
  const task = await getTaskContext(workspaceId, taskId);
  if (!task) throw new Error("Task not found in workspace");

  // Generate test plan
  const testPlan = await generateApiTestPlan(task, baseUrl, openApiSpec);

  const run = await createRun({
    workspaceId,
    projectId: task.project_id,
    taskId,
    triggerSource,
    mode: "api_test",
    createdBy: triggeredBy,
    generatedCases: testPlan.map((s) => ({ id: s.id, title: s.name, level: "api", objective: s.description, steps: [`${s.method} ${s.path}`], expected: [`HTTP ${s.expectedStatus}`] })),
    commands: testPlan.map((s) => `${s.method} ${baseUrl}${s.path}`),
    status: "running",
  });

  const stepResults = [];
  for (const step of testPlan) {
    const result = await executeApiStep(step, baseUrl, authToken);
    stepResults.push(result);
    // Live update
    await pool.query(
      `UPDATE testing_agent_runs SET output_json = jsonb_set(COALESCE(output_json,'{}'), '{stepResults}', $2::jsonb) WHERE id = $1`,
      [run.id, JSON.stringify(stepResults)]
    ).catch(() => {});
  }

  const passed = stepResults.filter((s) => s.status === "passed").length;
  const failed = stepResults.filter((s) => s.status === "failed").length;
  const finalStatus = failed > 0 ? "failed" : "passed";

  // Build insights
  const commandOutputs = stepResults.map((s) => ({
    command: `${s.method} ${s.url}`,
    passed: s.status === "passed",
    stdout: s.responseBody || "",
    stderr: s.error || "",
    durationMs: s.durationMs,
    timedOut: false,
  }));
  const insights = await generateCliRunInsights(commandOutputs, testPlan.map((s) => ({ title: s.name })), "api_test");

  const outputJson = {
    baseUrl,
    testPlan,
    stepResults,
    insights,
    summary: { total: stepResults.length, passed, failed },
  };

  await finishRun(run.id, { status: finalStatus, outputJson });

  return {
    runId: run.id,
    status: finalStatus,
    baseUrl,
    testPlan,
    stepResults,
    insights,
    summary: outputJson.summary,
  };
}

export async function generateAndSaveTestFile({
  workspaceId,
  taskId,
  saveToRepo = false,
  triggeredBy = null,
  triggerSource = "manual",
}) {
  if (!isUuid(taskId)) throw new Error("Invalid taskId");
  const task = await getTaskContext(workspaceId, taskId);
  if (!task) throw new Error("Task not found in workspace");

  const settings = await getTestingAgentSettings(workspaceId);
  const gitContext = await getGitContextForTask(workspaceId, task);
  const executionContext = await resolveExecutionContext({ workspaceId, task, workspaceSettings: settings });
  const fileContents = readChangedFiles(executionContext.repoPath, gitContext?.changedFiles || []);

  const generatedCases = await buildTestCasesWithLLM({
    task, gitContext, fileContents, framework: executionContext.framework,
  });

  const testFile = await generateTestCode({
    task,
    cases: generatedCases,
    framework: executionContext.framework,
    fileContents,
  });

  // Optionally write file to the repo
  let savedPath = null;
  if (saveToRepo && testFile.code && executionContext.repoPath && testFile.filename) {
    try {
      const testDir = path.join(executionContext.repoPath, "__ai_tests__");
      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      savedPath = path.join(testDir, testFile.filename);
      fs.writeFileSync(savedPath, testFile.code, "utf8");
    } catch (err) {
      console.warn("[testingAgent] Could not save test file:", err.message);
    }
  }

  const run = await createRun({
    workspaceId,
    projectId: task.project_id,
    taskId,
    triggerSource,
    mode: "generate",
    createdBy: triggeredBy,
    generatedCases,
    commands: [],
    status: "generated",
  });

  await finishRun(run.id, {
    status: "generated",
    outputJson: { generatedCases, testFile, savedPath, gitContext },
  });

  return {
    runId: run.id,
    generatedCases,
    testFile,
    savedPath,
    framework: executionContext.framework,
  };
}

// ─────────────────────────────────────────────────────────
// AUTO-DISCOVER CLI — scans repo structure, AI decides what to test, runs it
// Parallel to browser's autoDiscoverAndTest
// ─────────────────────────────────────────────────────────
async function discoverRepoTestPlan(repoPath, task, framework) {
  // Collect repo signals: file tree, config files, existing test patterns
  const signals = {};
  try {
    const pkgPath = path.join(repoPath, "package.json");
    if (fileExists(pkgPath)) signals.packageJson = readJsonFileSafe(pkgPath);
    for (const cf of ["pytest.ini", "jest.config.js", "jest.config.ts", "vitest.config.ts", ".eslintrc.js", "go.mod", "pom.xml"]) {
      if (fileExists(path.join(repoPath, cf))) signals[cf] = true;
    }
    // Sample directory listing
    try {
      signals.rootFiles = fs.readdirSync(repoPath).slice(0, 40);
    } catch { /* ok */ }
    // Find existing test directories
    const testDirs = ["__tests__", "test", "tests", "spec", "specs", "__ai_tests__"]
      .filter((d) => isDirectory(path.join(repoPath, d)));
    signals.testDirs = testDirs;
  } catch { /* ignore */ }

  const taskTitle = task?.task || "";
  const prompt = `You are a QA engineer auto-discovering tests for a codebase.

TASK: "${taskTitle}"
REPO PATH: ${repoPath}
FRAMEWORK: ${framework}
REPO SIGNALS: ${JSON.stringify(signals).slice(0, 600)}

Generate a test execution plan: 3-6 specific commands to run in this repo.
Consider: existing test scripts, framework conventions, what files to target.

Return ONLY this JSON:
{
  "commands": ["cmd1","cmd2","cmd3"],
  "rationale": "why these commands",
  "focusAreas": ["area1","area2"]
}`;

  try {
    const raw = await generateText({ prompt, maxTokens: 600 });
    const plan = parseJsonSafe(raw, null);
    if (plan?.commands && Array.isArray(plan.commands) && plan.commands.length > 0) return plan;
  } catch { /* fallback */ }

  const { recommendedCommands } = detectFramework(repoPath);
  return {
    commands: recommendedCommands.length ? recommendedCommands : ["npm test -- --runInBand"],
    rationale: "Framework-detected default commands",
    focusAreas: [],
  };
}

export async function autoDiscoverCliTests({
  workspaceId,
  taskId,
  triggeredBy = null,
  triggerSource = "manual",
}) {
  if (!isUuid(taskId)) throw new Error("Invalid taskId");
  const task = await getTaskContext(workspaceId, taskId);
  if (!task) throw new Error("Task not found in workspace");

  const settings = await getTestingAgentSettings(workspaceId);
  const gitContext = await getGitContextForTask(workspaceId, task);
  const executionContext = await resolveExecutionContext({ workspaceId, task, workspaceSettings: settings });

  if (!executionContext.repoPath) {
    throw new Error(`No repository path configured for project "${executionContext.projectName || task.project_name || "this project"}". Configure it in Testing Agent → Project Execution Profiles.`);
  }

  // Phase 1: Discover what to test
  const discoveredPlan = await discoverRepoTestPlan(executionContext.repoPath, task, executionContext.framework);
  const fileContents = readChangedFiles(executionContext.repoPath, gitContext?.changedFiles || []);
  const generatedCases = await buildTestCasesWithLLM({ task, gitContext, fileContents, framework: executionContext.framework });

  const run = await createRun({
    workspaceId,
    projectId: task.project_id,
    taskId,
    triggerSource,
    mode: "auto_discover",
    createdBy: triggeredBy,
    generatedCases,
    commands: discoveredPlan.commands,
    status: "running",
  });

  // Phase 2: Execute discovered commands with live updates + retry
  const commandOutputs = [];
  for (const cmd of discoveredPlan.commands) {
    const output = await executeCommandWithRetry(
      cmd, settings.max_runtime_seconds, executionContext.repoPath,
      async (liveStdout) => {
        await updateRunLive(run.id, [
          ...commandOutputs,
          { command: cmd, status: "running", stdout: liveStdout, stderr: "", passed: false, timedOut: false, durationMs: 0 },
        ]);
      }
    );
    if (!output.passed) {
      output.aiAnalysis = await aiAnalyzeCliFailure(cmd, output.stdout, output.stderr, executionContext.framework);
    }
    commandOutputs.push(output);
    await updateRunLive(run.id, commandOutputs);
  }

  const passed = commandOutputs.every((c) => c.passed);
  const failureInfo = passed ? null : classifyFailure(commandOutputs);
  const insights = await generateCliRunInsights(commandOutputs, generatedCases, "auto_discover");

  const outputJson = {
    discoveredPlan,
    gitContext,
    generatedCases,
    commandOutputs,
    insights,
    summary: {
      commandCount: discoveredPlan.commands.length,
      executedCount: commandOutputs.length,
      passed,
      failureReason: failureInfo?.reason || null,
    },
  };

  await finishRun(run.id, { status: passed ? "passed" : failureInfo?.status || "failed", outputJson });

  return {
    runId: run.id,
    status: passed ? "passed" : failureInfo?.status || "failed",
    discoveredPlan,
    generatedCases,
    insights,
    summary: outputJson.summary,
  };
}

// ─────────────────────────────────────────────────────────
// MULTI-SCENARIO CLI — 4 scenario categories, each a separate run
// Parallel to browser's runMultiScenario
// ─────────────────────────────────────────────────────────
async function generateMultiScenarioCommands(task, executionContext) {
  const baseCommands = executionContext.commands;
  const fw = executionContext.framework;
  const repoPath = executionContext.repoPath;

  // Build scenario-specific command variants
  const prompt = `QA architect. Generate 4 CLI test scenarios for this feature.

TASK: "${task?.task || ""}"
BASE COMMANDS: ${baseCommands.join(", ")}
FRAMEWORK: ${fw}
REPO PATH: ${repoPath}

Return JSON with exactly these keys — each value is an array of 1-3 shell commands:
{
  "unit":        ["cmd to run only unit tests"],
  "integration": ["cmd to run only integration tests"],
  "security":    ["cmd that checks for security issues (lint, audit, or unit security tests)"],
  "performance": ["cmd that times the tests or checks for performance regressions"]
}

Rules:
- Use the base commands as starting point, add flags/patterns to scope them
- security: prefer "npm audit --audit-level=high" or "bandit -r ." or similar
- performance: use "time <baseCmd>" or add --forceExit --detectOpenHandles
- If you can't narrow down, repeat the base command with a descriptive comment
Return ONLY the JSON object.`;

  try {
    const raw = await generateText({ prompt, maxTokens: 800 });
    const scenarios = parseJsonSafe(raw, null);
    if (scenarios && typeof scenarios === "object") {
      return {
        unit: Array.isArray(scenarios.unit) && scenarios.unit.length ? scenarios.unit : baseCommands,
        integration: Array.isArray(scenarios.integration) && scenarios.integration.length ? scenarios.integration : baseCommands,
        security: Array.isArray(scenarios.security) && scenarios.security.length ? scenarios.security : ["npm audit --audit-level=high"],
        performance: Array.isArray(scenarios.performance) && scenarios.performance.length ? scenarios.performance : baseCommands.map((c) => `time ${c}`),
      };
    }
  } catch { /* fallback */ }

  return {
    unit: baseCommands,
    integration: baseCommands,
    security: fw === "python" ? ["bandit -r . -ll"] : fw === "node" ? ["npm audit --audit-level=high"] : ["echo 'security scan not configured'"],
    performance: baseCommands.map((c) => `time ${c}`),
  };
}

export async function runCliMultiScenario({
  workspaceId,
  taskId,
  triggeredBy = null,
  triggerSource = "manual",
}) {
  if (!isUuid(taskId)) throw new Error("Invalid taskId");
  const task = await getTaskContext(workspaceId, taskId);
  if (!task) throw new Error("Task not found in workspace");

  const settings = await getTestingAgentSettings(workspaceId);
  const gitContext = await getGitContextForTask(workspaceId, task);
  const executionContext = await resolveExecutionContext({ workspaceId, task, workspaceSettings: settings });

  if (!executionContext.repoPath) {
    throw new Error(`No repository path configured for project "${executionContext.projectName || task.project_name || "this project"}".`);
  }

  const fileContents = readChangedFiles(executionContext.repoPath, gitContext?.changedFiles || []);
  const scenarioCommands = await generateMultiScenarioCommands(task, executionContext);
  const LABELS = { unit: "Unit Tests", integration: "Integration Tests", security: "Security Scan", performance: "Performance" };

  // Generate test cases once and reuse across all scenarios (avoids 4x LLM calls)
  const sharedGeneratedCases = await buildTestCasesWithLLM({
    task, gitContext, fileContents, framework: executionContext.framework,
  });

  const scenarioResults = [];

  for (const [type, cmds] of Object.entries(scenarioCommands)) {
    if (!cmds.length) continue;

    // Filter cases relevant to this scenario type; fall back to all cases
    const generatedCases = sharedGeneratedCases.filter((c) =>
      type === "security" ? /security|auth|injection|xss|csrf/i.test(`${c.level} ${c.title}`) :
      type === "performance" ? /performance|load|speed|latency|benchmark/i.test(`${c.level} ${c.title}`) :
      type === "integration" ? /integration|e2e|contract|api/i.test(`${c.level} ${c.title}`) :
      /unit|basic|functional/i.test(`${c.level} ${c.title}`)
    ).slice(0, 6) || sharedGeneratedCases.slice(0, 6);

    const run = await createRun({
      workspaceId,
      projectId: task.project_id,
      taskId,
      triggerSource,
      mode: "multi_scenario",
      createdBy: triggeredBy,
      generatedCases,
      commands: cmds,
      status: "running",
    });

    const commandOutputs = [];
    for (const cmd of cmds) {
      const output = await executeCommandWithRetry(
        cmd, settings.max_runtime_seconds, executionContext.repoPath,
        async (liveStdout) => {
          await updateRunLive(run.id, [
            ...commandOutputs,
            { command: cmd, status: "running", stdout: liveStdout, stderr: "", passed: false, timedOut: false, durationMs: 0 },
          ]);
        }
      );
      if (!output.passed) {
        output.aiAnalysis = await aiAnalyzeCliFailure(cmd, output.stdout, output.stderr, executionContext.framework);
      }
      commandOutputs.push(output);
      await updateRunLive(run.id, commandOutputs);
    }

    const passed = commandOutputs.every((c) => c.passed);
    const failureInfo = passed ? null : classifyFailure(commandOutputs);
    const insights = await generateCliRunInsights(commandOutputs, generatedCases, `multi_scenario:${type}`);

    await finishRun(run.id, {
      status: passed ? "passed" : failureInfo?.status || "failed",
      outputJson: { scenarioType: type, scenarioLabel: LABELS[type], commandOutputs, insights, generatedCases },
    });

    scenarioResults.push({
      runId: run.id,
      type,
      label: LABELS[type],
      status: passed ? "passed" : failureInfo?.status || "failed",
      commands: cmds,
      insights,
      summary: {
        total: commandOutputs.length,
        passed: commandOutputs.filter((c) => c.passed).length,
        failed: commandOutputs.filter((c) => !c.passed).length,
      },
    });
  }

  const allPassed = scenarioResults.every((s) => s.status === "passed");
  const allFailed = scenarioResults.every((s) => s.status !== "passed");

  return {
    description: task.task,
    scenarios: scenarioResults,
    overallStatus: allPassed ? "passed" : allFailed ? "failed" : "partial",
    summary: {
      total: scenarioResults.length,
      passed: scenarioResults.filter((s) => s.status === "passed").length,
      failed: scenarioResults.filter((s) => s.status !== "passed").length,
    },
  };
}

export async function listTestingAgentRuns({
  workspaceId,
  taskId = null,
  page = 1,
  limit = 20,
  search = "",
}) {
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);
  const safePage = Math.max(Number(page || 1), 1);
  const offset = (safePage - 1) * safeLimit;

  const params = [workspaceId];
  const where = ["r.workspace_id = $1"];
  let idx = 2;

  if (taskId) {
    where.push(`r.task_id = $${idx}`);
    params.push(taskId);
    idx += 1;
  }

  if (search && search.trim()) {
    where.push(`(t.task ILIKE $${idx} OR p.name ILIKE $${idx})`);
    params.push(`%${search.trim()}%`);
    idx += 1;
  }

  const countSql = `
    SELECT COUNT(*)::INT AS total
    FROM testing_agent_runs r
    INNER JOIN tasks t ON t.id = r.task_id
    INNER JOIN projects p ON p.id = r.project_id
    WHERE ${where.join(" AND ")}
  `;

  const { rows: countRows } = await pool.query(countSql, params);
  const total = Number(countRows?.[0]?.total || 0);

  params.push(safeLimit);
  const limIdx = idx;
  idx += 1;
  params.push(offset);
  const offIdx = idx;

  const { rows } = await pool.query(
    `
    SELECT
      r.*,
      t.task AS task_name,
      p.name AS project_name
    FROM testing_agent_runs r
    INNER JOIN tasks t ON t.id = r.task_id
    INNER JOIN projects p ON p.id = r.project_id
    WHERE ${where.join(" AND ")}
    ORDER BY r.created_at DESC
    LIMIT $${limIdx}
    OFFSET $${offIdx}
    `,
    params
  );

  const items = rows.map((r) => ({
    ...r,
    generated_cases: parseJsonMaybe(r.generated_cases, []),
    commands: parseJsonMaybe(r.commands, []),
    output_json: parseJsonMaybe(r.output_json, {}),
  }));

  const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
    },
  };
}

export async function getTestingAgentRunById({ workspaceId, runId }) {
  const { rows } = await pool.query(
    `
    SELECT
      r.*,
      t.task AS task_name,
      p.name AS project_name
    FROM testing_agent_runs r
    INNER JOIN tasks t ON t.id = r.task_id
    INNER JOIN projects p ON p.id = r.project_id
    WHERE r.workspace_id = $1
      AND r.id = $2
    LIMIT 1
    `,
    [workspaceId, runId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...r,
    generated_cases: parseJsonMaybe(r.generated_cases, []),
    commands: parseJsonMaybe(r.commands, []),
    output_json: parseJsonMaybe(r.output_json, {}),
  };
}

export async function handleGitLinkedTaskAutomation({
  workspaceId,
  taskId,
  actorId = null,
}) {
  const settings = await getTestingAgentSettings(workspaceId);
  if (!settings.enabled) return { skipped: true, reason: "testing agent disabled" };

  if (settings.auto_generate_on_git) {
    try {
      await generateTaskTestCases({
        workspaceId,
        taskId,
        triggeredBy: actorId,
        triggerSource: "git-auto",
      });
    } catch (err) {
      console.error("[git-auto] generateTaskTestCases failed:", { workspaceId, taskId, error: err?.message });
      // Don't rethrow — a generate failure must not block the run step
    }
  }

  if (settings.auto_run_on_git) {
    try {
      return await runTaskTests({
        workspaceId,
        taskId,
        triggeredBy: actorId,
        triggerSource: "git-auto",
      });
    } catch (err) {
      console.error("[git-auto] runTaskTests failed:", { workspaceId, taskId, error: err?.message });
      return { skipped: true, reason: `runTaskTests failed: ${err?.message}` };
    }
  }

  return { skipped: true, reason: "auto_run_on_git disabled" };
}

export async function listTestingAgentTaskOptions({
  workspaceId,
  search = "",
  limit = 20,
}) {
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);
  const params = [workspaceId];
  const where = ["t.workspace_id = $1"];
  let idx = 2;

  if (search && search.trim()) {
    where.push(`(t.task ILIKE $${idx} OR p.name ILIKE $${idx} OR u.username ILIKE $${idx})`);
    params.push(`%${search.trim()}%`);
    idx += 1;
  }

  params.push(safeLimit);
  const limIdx = idx;

  const { rows } = await pool.query(
    `
    SELECT
      t.id,
      t.task,
      t.status,
      t.priority,
      t.project_id,
      t.ticket_number,
      p.name AS project_name,
      p.project_code,
      u.username AS assignee_username
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assigned_to
    WHERE ${where.join(" AND ")}
    ORDER BY t.updated_at DESC
    LIMIT $${limIdx}
    `,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    task: r.task,
    status: r.status,
    priority: r.priority,
    projectId: r.project_id,
    projectName: r.project_name,
    assigneeName: r.assignee_username || null,
    taskKey: r.project_code && r.ticket_number ? `${r.project_code}-${r.ticket_number}` : null,
  }));
}

export async function listTestingAgentProjectProfiles({
  workspaceId,
  search = "",
}) {
  const params = [workspaceId];
  let where = "p.workspace_id = $1";
  if (search && search.trim()) {
    where += " AND (p.name ILIKE $2 OR p.project_code ILIKE $2 OR g.repo_full_name ILIKE $2)";
    params.push(`%${search.trim()}%`);
  }

  const { rows } = await pool.query(
    `
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      p.project_code,
      g.repo_full_name,
      tp.repo_path,
      tp.framework,
      tp.commands,
      tp.enabled
    FROM projects p
    LEFT JOIN git_project_automation_settings g
      ON g.workspace_id = p.workspace_id
      AND g.project_id = p.id
    LEFT JOIN testing_agent_project_profiles tp
      ON tp.workspace_id = p.workspace_id
      AND tp.project_id = p.id
    WHERE ${where}
    ORDER BY p.name ASC
    `,
    params
  );

  return rows.map((row) => {
    const repoPath = isNonEmptyString(row.repo_path) ? path.resolve(row.repo_path) : null;
    const detected = repoPath && isDirectory(repoPath)
      ? detectFramework(repoPath)
      : { framework: "unknown", recommendedCommands: [] };

    return {
      projectId: row.project_id,
      projectName: row.project_name,
      projectCode: row.project_code,
      repoFullName: row.repo_full_name || null,
      repoPath,
      repoPathExists: Boolean(repoPath && isDirectory(repoPath)),
      framework: row.framework || detected.framework || "unknown",
      commands: normalizeCommands(parseJsonMaybe(row.commands, [])),
      recommendedCommands: detected.recommendedCommands,
      enabled: row.enabled !== false,
    };
  });
}

export async function upsertTestingAgentProjectProfile({
  workspaceId,
  projectId,
  repoPath,
  framework,
  commands,
  enabled = true,
  actorId = null,
}) {
  const resolvedRepoPath = isNonEmptyString(repoPath) ? path.resolve(repoPath.trim()) : null;
  const normalizedFramework = isNonEmptyString(framework) ? framework.trim().toLowerCase() : null;
  const normalizedCommands = normalizeCommands(commands);

  const { rows } = await pool.query(
    `
    INSERT INTO testing_agent_project_profiles (
      workspace_id,
      project_id,
      repo_path,
      framework,
      commands,
      enabled,
      created_by,
      updated_by
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (workspace_id, project_id)
    DO UPDATE SET
      repo_path = EXCLUDED.repo_path,
      framework = EXCLUDED.framework,
      commands = EXCLUDED.commands,
      enabled = EXCLUDED.enabled,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
    `,
    [
      workspaceId,
      projectId,
      resolvedRepoPath,
      normalizedFramework,
      JSON.stringify(normalizedCommands),
      enabled !== false,
      actorId,
    ]
  );

  const row = rows[0];
  return {
    ...row,
    commands: normalizeCommands(parseJsonMaybe(row?.commands, [])),
  };
}
