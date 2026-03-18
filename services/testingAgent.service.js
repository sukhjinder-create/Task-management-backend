import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";
import {
  createRunController,
  isRunCancelledError,
  requestTestingRunStop,
  RunCancelledError,
  safeJsonStringify,
} from "./testingRunControl.service.js";
import {
  buildPdfBufferFromReport,
  buildRunReportDocument,
} from "./testingRunReport.service.js";
import { getTaskLinks } from "./taskLinks.service.js";

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
      [runId, safeJsonStringify(partialOutput)]
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

function uniqueStrings(values = [], max = 12) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function toStringArray(value, max = 8) {
  if (Array.isArray(value)) return uniqueStrings(value, max);
  if (isNonEmptyString(value)) return uniqueStrings([value], max);
  return [];
}

function splitIntoSignals(text = "", max = 10) {
  return uniqueStrings(
    String(text || "")
      .split(/\r?\n|[.?!]\s+|;+/)
      .map((part) => part.replace(/^[-*•\d.\s]+/, "").trim())
      .filter((part) => part.length >= 8),
    max
  );
}

async function getTaskContext(workspaceId, taskId) {
  const taskPromise = pool.query(
    `
    SELECT
      t.*,
      COALESCE(st.total_subtasks, 0) AS subtasks_total,
      COALESCE(st.completed_subtasks, 0) AS subtasks_completed,
      p.name AS project_name,
      p.project_code,
      u.username AS assignee_username,
      creator.username AS creator_username,
      CASE WHEN p.project_code IS NOT NULL AND t.ticket_number IS NOT NULL
           THEN p.project_code || '-' || t.ticket_number END AS display_id
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users creator ON creator.id = t.added_by
    LEFT JOIN (
      SELECT
        task_id,
        COUNT(*) AS total_subtasks,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_subtasks
      FROM subtasks
      GROUP BY task_id
    ) st ON st.task_id = t.id
    WHERE t.id = $1
      AND t.workspace_id = $2
    LIMIT 1
    `,
    [taskId, workspaceId]
  );

  const subtasksPromise = pool.query(
    `
    SELECT
      id,
      COALESCE(title, subtask) AS title,
      status,
      priority,
      due_date,
      created_at
    FROM subtasks
    WHERE task_id = $1
    ORDER BY created_at ASC
    LIMIT 20
    `,
    [taskId]
  );

  const commentsPromise = pool.query(
    `
    SELECT
      c.id,
      c.comment_text,
      c.created_at,
      u.username AS author_username
    FROM comments c
    LEFT JOIN users u ON u.id = c.added_by
    WHERE c.task_id = $1
      AND c.workspace_id = $2
    ORDER BY c.created_at DESC
    LIMIT 8
    `,
    [taskId, workspaceId]
  );

  const activityPromise = pool.query(
    `
    SELECT
      l.action_type,
      l.old_value,
      l.new_value,
      l.created_at,
      actor.username AS actor_username
    FROM task_activity_logs l
    LEFT JOIN users actor ON actor.id = l.actor_id
    WHERE l.task_id = $1
      AND l.workspace_id = $2
    ORDER BY l.created_at DESC
    LIMIT 12
    `,
    [taskId, workspaceId]
  );

  const [taskRes, subtasksRes, commentsRes, activityRes, linkedTasks] = await Promise.all([
    taskPromise,
    subtasksPromise,
    commentsPromise,
    activityPromise,
    getTaskLinks({ taskId }).catch(() => []),
  ]);

  const task = taskRes.rows[0];
  if (!task) return null;

  return {
    ...task,
    subtasks: subtasksRes.rows || [],
    recentComments: commentsRes.rows || [],
    recentActivity: activityRes.rows || [],
    linkedTasks: Array.isArray(linkedTasks) ? linkedTasks : [],
  };
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

function summarizeActivityLog(log = {}) {
  const action = String(log?.action_type || "TASK_UPDATED")
    .replace(/_/g, " ")
    .toLowerCase();
  const actor = isNonEmptyString(log?.actor_username) ? `${log.actor_username} ` : "";
  const oldValue = parseJsonMaybe(log?.old_value, {});
  const newValue = parseJsonMaybe(log?.new_value, {});
  const details = [];

  if (newValue?.status && oldValue?.status !== newValue.status) {
    details.push(`status ${oldValue?.status || "unset"} -> ${newValue.status}`);
  }
  if (newValue?.priority && oldValue?.priority !== newValue.priority) {
    details.push(`priority ${oldValue?.priority || "unset"} -> ${newValue.priority}`);
  }
  if (newValue?.assigned_to && oldValue?.assigned_to !== newValue.assigned_to) {
    details.push("assignee changed");
  }

  return details.length > 0
    ? `${actor}${action}: ${details.join(", ")}`
    : `${actor}${action}`;
}

function inferImpactFromFile(relPath = "", content = "") {
  const lower = `${relPath}\n${content}`.toLowerCase();
  const areas = [];
  const nextChecks = [];
  const add = (area, check) => {
    if (area) areas.push(area);
    if (check) nextChecks.push(check);
  };

  if (/route|controller|api|endpoint/.test(lower)) {
    add("API contract", "verify status codes, validation responses, and payload shape");
  }
  if (/service|handler|usecase|domain/.test(lower)) {
    add("Business rules", "verify side effects, derived values, and downstream state transitions");
  }
  if (/repo|repository|model|schema|migration|sql|db/.test(lower)) {
    add("Persistence", "verify data writes, reads, constraints, and rollback safety");
  }
  if (/auth|permission|role|access|token|session/.test(lower)) {
    add("Authorization", "verify allowed roles succeed and forbidden users are blocked");
  }
  if (/vote|ballot|poll/.test(lower)) {
    add("Voting flow", "verify counters, duplicate-vote protection, and aggregate refresh");
  }
  if (/sprint|backlog|board|kanban/.test(lower)) {
    add("Sprint planning", "verify sprint totals, backlog movement, and carry-over rules");
  }
  if (/youtrack|jira|asana|adapter|webhook|integration|sync/.test(lower)) {
    add("External integration", "verify payload mapping, retries, and duplicate prevention");
  }
  if (/queue|job|cron|worker|schedule/.test(lower)) {
    add("Background execution", "verify delayed effects, retry safety, and idempotency");
  }
  if (/socket|realtime|event|emit/.test(lower)) {
    add("Realtime updates", "verify broadcasts, refresh events, and live counters");
  }
  if (/notify|notification|email|mail|sms/.test(lower)) {
    add("Notifications", "verify trigger conditions and delivery payload content");
  }
  if (/upload|attachment|file/.test(lower)) {
    add("File handling", "verify validation, storage, and access control for uploaded files");
  }
  if (/page|component|screen|view|modal|dialog/.test(lower)) {
    add("UI flow", "verify visible state changes, validation messages, and navigation continuity");
  }

  if (areas.length === 0) {
    add(path.basename(relPath || "changed module"), "verify the direct behavior and its nearest regression surface");
  }

  return {
    path: relPath,
    label: relPath ? relPath.split(/[\\/]/).slice(-2).join("/") : "task context",
    areas: uniqueStrings(areas, 4),
    nextChecks: uniqueStrings(nextChecks, 4),
  };
}

function buildTaskTestingBrief({ task, gitContext, fileContents = {} }) {
  const changedFiles = Array.isArray(gitContext?.changedFiles) ? gitContext.changedFiles.slice(0, 12) : [];
  const changedFileImpacts = changedFiles.map((file) => inferImpactFromFile(file, fileContents[file] || ""));
  const acceptanceSignals = uniqueStrings([
    ...splitIntoSignals(task?.description, 8),
    ...(task?.subtasks || []).map((item) => item?.title || item?.subtask).filter(Boolean),
  ], 10);
  const commentSignals = uniqueStrings(
    (task?.recentComments || []).map((comment) =>
      `${comment?.author_username || "comment"}: ${String(comment?.comment_text || "").slice(0, 140)}`
    ),
    4
  );
  const linkedRisks = uniqueStrings(
    (task?.linkedTasks || []).map((link) => {
      const label = link?.linked_display_id || link?.linked_task_title || "linked task";
      return `${String(link?.link_type || "relates_to").replace(/_/g, " ")} -> ${label} (${link?.linked_status || "unknown"})`;
    }),
    6
  );
  const activityNotes = uniqueStrings((task?.recentActivity || []).map(summarizeActivityLog), 6);
  const impactedAreas = uniqueStrings(changedFileImpacts.flatMap((item) => item.areas), 10);
  const followUpChecks = uniqueStrings([
    ...changedFileImpacts.flatMap((item) => item.nextChecks),
    ...linkedRisks.map((risk) => `check linked workflow impact: ${risk}`),
  ], 10);
  const repoSignals = uniqueStrings(
    changedFileImpacts.map((item) => `${item.label}: ${(item.areas || []).join(", ") || "module change"}`),
    8
  );

  const suggestedLevels = [];
  if (impactedAreas.some((area) => /api|business|persistence|integration|background|realtime/i.test(area))) {
    suggestedLevels.push("integration");
  }
  if (impactedAreas.some((area) => /ui flow/i.test(area))) suggestedLevels.push("e2e");
  if (impactedAreas.some((area) => /authorization/i.test(area))) suggestedLevels.push("security");
  if (impactedAreas.some((area) => /persistence|business/i.test(area))) suggestedLevels.push("regression");
  if (suggestedLevels.length === 0) suggestedLevels.push("integration", "regression");

  return {
    acceptanceSignals,
    commentSignals,
    linkedRisks,
    activityNotes,
    impactedAreas,
    followUpChecks,
    repoSignals,
    changedFileImpacts,
    suggestedLevels: uniqueStrings(suggestedLevels, 6),
  };
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

function normalizeGeneratedCase(rawCase = {}, index = 0, fallback = {}) {
  const allowedLevels = new Set([
    "unit",
    "integration",
    "api",
    "ui",
    "e2e",
    "edge",
    "security",
    "performance",
    "regression",
    "functional",
    "basic",
  ]);
  const rawLevel = String(rawCase?.level || fallback?.level || "integration").toLowerCase();
  const rawSteps = toStringArray(rawCase?.steps, 8);
  const rawExpected = toStringArray(rawCase?.expected, 6);

  return {
    ...rawCase,
    id: `TC-${String(index + 1).padStart(3, "0")}`,
    level: allowedLevels.has(rawLevel) ? rawLevel : String(fallback?.level || "integration").toLowerCase(),
    title: String(rawCase?.title || fallback?.title || `Test case ${index + 1}`).trim(),
    objective: String(
      rawCase?.objective ||
      rawCase?.whyThisMatters ||
      fallback?.objective ||
      `Validate behavior for ${fallback?.title || "the task"}`
    ).trim(),
    preconditions: toStringArray(rawCase?.preconditions || fallback?.preconditions, 4),
    steps: rawSteps.length > 0 ? rawSteps : toStringArray(fallback?.steps, 8),
    expected: rawExpected.length > 0 ? rawExpected : toStringArray(fallback?.expected, 6),
    affectedAreas: toStringArray(rawCase?.affectedAreas || fallback?.affectedAreas, 6),
    followUpChecks: toStringArray(rawCase?.followUpChecks || fallback?.followUpChecks, 5),
    codeSnippet: isNonEmptyString(rawCase?.codeSnippet) ? String(rawCase.codeSnippet).trim() : String(fallback?.codeSnippet || ""),
  };
}

async function buildTestCasesWithLLM({ task, gitContext, fileContents = {}, framework = "unknown" }) {
  const taskTitle = task?.task || "";
  const fallbackCases = buildTestCasesFallback({ task, gitContext, fileContents });
  const brief = buildTaskTestingBrief({ task, gitContext, fileContents });
  const changedFiles = Array.isArray(gitContext?.changedFiles) ? gitContext.changedFiles.slice(0, 12) : [];
  const codeSnippets = Object.entries(fileContents)
    .slice(0, 3)
    .map(([file, content]) => `// ${file}\n${String(content || "").slice(0, 700)}`)
    .join("\n\n");

  const prompt = `You are a principal QA engineer writing release-quality tests for a real product change.
Think like a human tester who understands the feature, the side effects, and what must be checked next after every action.

TASK:
- Title: "${taskTitle}"
${task?.display_id ? `- Ticket: "${task.display_id}"` : ""}
${task?.description ? `- Description: "${String(task.description).slice(0, 700)}"` : ""}
${task?.status ? `- Current status: ${task.status}` : ""}
${task?.priority ? `- Priority: ${task.priority}` : ""}
${task?.assignee_username ? `- Assignee: ${task.assignee_username}` : ""}

ACCEPTANCE SIGNALS:
${brief.acceptanceSignals.map((item) => `- ${item}`).join("\n") || "- infer from task title and code context"}

CHANGED FILE IMPACT:
${brief.repoSignals.map((item) => `- ${item}`).join("\n") || "- no linked git change detected"}

RELATED RISKS:
${brief.linkedRisks.map((item) => `- ${item}`).join("\n") || "- none"}

RECENT ACTIVITY:
${brief.activityNotes.map((item) => `- ${item}`).join("\n") || "- none"}

RECENT COMMENTS:
${brief.commentSignals.map((item) => `- ${item}`).join("\n") || "- none"}

FRAMEWORK: ${framework}
CHANGED FILES: ${changedFiles.join(", ") || "none"}
${codeSnippets ? `CODE CONTEXT:\n${codeSnippets}` : ""}

Generate 8-12 concrete test cases that a strong human tester would actually run.
Each case must explain:
1. the exact behavior being exercised,
2. the immediate effect that proves the action worked,
3. the downstream or adjacent area that must be checked next because this change can ripple there.

Return ONLY this JSON array:
[{
  "id":"TC-001",
  "level":"unit|integration|api|ui|e2e|edge|security|performance|regression",
  "title":"specific human-readable test title",
  "objective":"why this test matters for the task",
  "preconditions":["specific setup state"],
  "steps":["specific action with data","immediate verification","next downstream check"],
  "expected":["specific observable result","specific side effect or regression proof"],
  "affectedAreas":["module, endpoint, workflow, or file area"],
  "followUpChecks":["what to verify next and why"],
  "codeSnippet":"runnable ${framework} test code with real assertions, or empty string if code would be misleading"
}]

Rules:
- No placeholders or generic titles.
- Use task language, changed files, comments, activity, and related risks when relevant.
- Every state-changing case must include the immediate effect and the next thing to validate.
- Cover happy path, validation/negative path, regression, and security/permissions/data integrity when relevant.
- If integrations, jobs, notifications, or realtime updates are implicated, include downstream side-effect checks.
- Return ONLY the JSON array.
- titles/steps MUST be specific to "${taskTitle}" — no generic placeholders

`;

  try {
    const raw = await generateText({ prompt, maxTokens: 3400 });
    const cases = parseJsonSafe(raw, null);
    if (Array.isArray(cases) && cases.length > 0) {
      return cases.slice(0, 15).map((item, index) =>
        normalizeGeneratedCase(item, index, fallbackCases[index] || fallbackCases[0] || {})
      );
    }
  } catch (err) {
    console.error("Enhanced LLM test case generation failed:", err.message);
  }

  return fallbackCases;
}

function buildTestCasesFallback({ task, gitContext, fileContents = {} }) {
  const brief = buildTaskTestingBrief({ task, gitContext, fileContents });
  const primarySignal = brief.acceptanceSignals[0] || task?.task || "core workflow";
  const secondarySignal = brief.acceptanceSignals[1] || primarySignal;
  const primaryAreas = brief.impactedAreas.slice(0, 3);
  const leadImpact = brief.changedFileImpacts[0];
  const leadFollowUp = brief.followUpChecks[0] || "check the closest downstream workflow for regressions";
  const impactText = brief.impactedAreas.join(" ").toLowerCase();
  const cases = [];
  let idx = 1;

  const add = ({
    level,
    title,
    objective,
    steps,
    expected,
    preconditions = [],
    affectedAreas = [],
    followUpChecks = [],
    codeSnippet = "",
  }) => {
    cases.push({
      id: `TC-${String(idx++).padStart(3, "0")}`,
      level,
      title,
      objective,
      preconditions: uniqueStrings(preconditions, 4),
      steps: uniqueStrings(steps, 8),
      expected: uniqueStrings(expected, 6),
      affectedAreas: uniqueStrings(affectedAreas, 6),
      followUpChecks: uniqueStrings(followUpChecks, 5),
      codeSnippet,
    });
  };

  add({
    level: brief.suggestedLevels.includes("e2e") ? "e2e" : "integration",
    title: `${task?.task || "Task"} — primary flow reaches the intended outcome`,
    objective: `Prove the main behavior for "${task?.task || "the task"}" works and the next dependent surface stays correct.`,
    preconditions: [
      task?.display_id ? `Task context available for ${task.display_id}` : "Required fixtures and permissions are set up",
    ],
    steps: [
      `Prepare the state needed to exercise: ${primarySignal}`,
      `Perform the main user or system action for "${task?.task || "the task"}" with valid data`,
      `Verify the immediate success state tied to "${primarySignal}"`,
      leadFollowUp,
    ],
    expected: [
      `${primarySignal} succeeds without errors`,
      "Persisted state and visible outputs remain aligned after the change",
    ],
    affectedAreas: primaryAreas,
    followUpChecks: brief.followUpChecks.slice(0, 2),
  });

  add({
    level: "edge",
    title: `${task?.task || "Task"} — invalid and empty inputs fail safely`,
    objective: `Validate that "${secondarySignal}" rejects incomplete or malformed input without corrupting state.`,
    steps: [
      `Attempt "${task?.task || "the workflow"}" with empty required data`,
      "Repeat with malformed, boundary, or whitespace-only values",
      "Verify the error is specific and no partial state is persisted",
      leadFollowUp,
    ],
    expected: [
      "Validation feedback is explicit and user-safe",
      "No inconsistent data or silent partial success is introduced",
    ],
    affectedAreas: primaryAreas,
    followUpChecks: [
      "confirm lists, detail views, and aggregates did not change after invalid attempts",
    ],
  });

  if (/authorization|auth/.test(impactText) || /\bauth\b|\blogin\b|\brole\b|\bpermission\b/i.test(`${task?.task || ""} ${task?.description || ""}`)) {
    add({
      level: "security",
      title: `${task?.task || "Task"} — permissions and sensitive paths remain enforced`,
      objective: "Ensure the change does not open unauthorized access or leak sensitive data.",
      steps: [
        "Repeat the primary action with missing authentication",
        "Repeat with an authenticated user lacking the required role or scope",
        "Verify forbidden paths return the correct denial behavior and no protected data appears",
        "Confirm allowed roles still succeed on the intended flow",
      ],
      expected: [
        "Unauthorized or under-privileged access is denied consistently",
        "Authorized users can still complete the intended workflow",
      ],
      affectedAreas: uniqueStrings([...primaryAreas, "Authorization"], 5),
      followUpChecks: [
        "check related endpoints/screens for the same permission boundary",
      ],
    });
  }

  if (/api contract|business rules|persistence/.test(impactText)) {
    add({
      level: /api contract/.test(impactText) ? "api" : "integration",
      title: `${task?.task || "Task"} — persisted data and contract stay consistent`,
      objective: `Verify changes in ${leadImpact?.label || "the changed code"} preserve API/database consistency.`,
      steps: [
        "Trigger the behavior with a valid payload or command",
        "Verify the immediate response, status, and returned fields",
        "Read back the affected entity from its source of truth",
        "Confirm dependent summaries, counts, or linked records reflect the same state",
      ],
      expected: [
        "Returned data matches persisted data",
        "No duplicate, partial, or stale state remains after the operation",
      ],
      affectedAreas: uniqueStrings([...primaryAreas, ...(leadImpact?.areas || [])], 6),
      followUpChecks: uniqueStrings([
        "re-run the read path and adjacent workflow to ensure the update is visible everywhere",
        ...brief.followUpChecks,
      ], 3),
    });
  }

  if (/external integration|background execution|realtime updates|notifications/.test(impactText)) {
    add({
      level: "integration",
      title: `${task?.task || "Task"} — downstream side effects trigger exactly once`,
      objective: "Validate the change reaches external or asynchronous systems without duplicates or missing events.",
      steps: [
        `Execute the action that should trigger the side effect in ${leadImpact?.label || "the changed area"}`,
        "Verify the immediate local success state",
        "Check the downstream event, notification, sync, or background outcome",
        "Repeat the action or retry path to confirm idempotency and duplicate prevention",
      ],
      expected: [
        "Required side effects are emitted with correct payloads",
        "Retries or repeated submissions do not create duplicate outcomes",
      ],
      affectedAreas: uniqueStrings([...primaryAreas, "downstream integrations"], 6),
      followUpChecks: uniqueStrings([
        ...brief.followUpChecks,
        "inspect retries, webhooks, queues, or realtime updates for duplicate or missing events",
      ], 4),
    });
  }

  if (/ui flow/.test(impactText)) {
    add({
      level: "ui",
      title: `${task?.task || "Task"} — visible state stays in sync after user actions`,
      objective: "Ensure the UI reflects the true backend state after create/update/delete style interactions.",
      steps: [
        "Open the changed screen or module and perform the primary interaction",
        "Verify inline feedback, button state, and navigation flow immediately after the action",
        "Refresh or revisit the related list/detail view",
        "Confirm the same state is shown consistently after reload or navigation",
      ],
      expected: [
        "The immediate visual feedback matches the actual saved state",
        "Reloaded or adjacent screens show the same updated data",
      ],
      affectedAreas: uniqueStrings([...primaryAreas, "UI flow"], 5),
      followUpChecks: [
        "check adjacent list/detail/summary surfaces for stale or missing UI updates",
      ],
    });
  }

  add({
    level: "regression",
    title: `${task?.task || "Task"} — related workflows remain stable`,
    objective: "Guard the nearest linked or adjacent workflows most likely to break from this change.",
    steps: [
      `Run the nearest related workflow touching ${primaryAreas.join(", ") || "the affected module"}`,
      "Exercise the task from a second entry point if one exists",
      "Verify linked tasks, summaries, and previously working paths still behave correctly",
      "Inspect logs or diagnostics for new warnings, retries, or hidden failures",
    ],
    expected: [
      "No behavioral regression appears in adjacent workflows",
      "Operational signals remain clean after the run",
    ],
    affectedAreas: uniqueStrings([...primaryAreas, ...brief.linkedRisks], 6),
    followUpChecks: uniqueStrings([
      ...brief.followUpChecks,
      "confirm the closest linked workflow still completes successfully",
    ], 4),
  });

  return cases.slice(0, 12);
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
  const casesSummary = cases.slice(0, 6).map((c) => {
    const followUp = Array.isArray(c?.followUpChecks) && c.followUpChecks.length > 0
      ? ` Follow-up: ${c.followUpChecks.join("; ")}.`
      : "";
    return `- ${c.title}: ${c.objective}.${followUp}`;
  }).join("\n");
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
function executeCommand(command, timeoutSec, cwd = null, onProgress = null, runController = null) {
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
    let cancelled = false;
    let lineCount = 0;
    let settled = false;
    let polling = false;

    const stopChild = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };

    const timeoutValue = Number(timeoutSec || 0);
    const timer = timeoutValue > 0
      ? setTimeout(() => {
          killed = true;
          stopChild();
        }, Math.max(10, timeoutValue) * 1000)
      : null;

    const cancelInterval = runController
      ? setInterval(async () => {
          if (settled || polling) return;
          polling = true;
          try {
            await runController.assertActive({ phase: "command", command });
          } catch (error) {
            if (isRunCancelledError(error)) {
              cancelled = true;
              stderr += `\n[testingAgent] ${error.message}`;
              stopChild();
            }
          } finally {
            polling = false;
          }
        }, 1000)
      : null;

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
      settled = true;
      if (timer) clearTimeout(timer);
      if (cancelInterval) clearInterval(cancelInterval);
      resolve({
        command,
        exitCode: Number(code ?? -1),
        passed: !killed && !cancelled && Number(code ?? 1) === 0,
        timedOut: killed,
        cancelled,
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
async function executeCommandWithRetry(command, timeoutSec, cwd, onProgress = null, runController = null) {
  const result = await executeCommand(command, timeoutSec, cwd, onProgress, runController);
  if (result.cancelled) {
    return result;
  }
  if (!result.passed && isTransientFailure(result)) {
    console.warn(`[testingAgent] Retrying "${command}" after transient failure`);
    await new Promise((r) => setTimeout(r, 2000)); // 2s backoff
    const retry = await executeCommand(command, timeoutSec, cwd, onProgress, runController);
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

function listRepoFiles(repoPath, { maxDepth = 4, maxEntries = 400 } = {}) {
  const files = [];

  function walk(currentPath, depth) {
    if (files.length >= maxEntries || depth > maxDepth || !isDirectory(currentPath)) return;

    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxEntries) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;
      const absPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, depth + 1);
      } else if (entry.isFile()) {
        files.push(path.relative(repoPath, absPath).replace(/\\/g, "/"));
      }
    }
  }

  walk(repoPath, 0);
  return files;
}

function dedupeCommands(commands = [], max = 8) {
  const seen = new Set();
  const out = [];
  for (const cmd of commands) {
    const clean = String(cmd || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function collectRepoSignals(repoPath) {
  const signals = {
    packageJson: null,
    rootFiles: [],
    testDirs: [],
    testFiles: [],
    configFiles: [],
    sourceDirs: [],
  };

  try {
    const pkgPath = path.join(repoPath, "package.json");
    if (fileExists(pkgPath)) signals.packageJson = readJsonFileSafe(pkgPath);
    signals.rootFiles = fs.readdirSync(repoPath).slice(0, 60);
  } catch { /* ignore */ }

  const files = listRepoFiles(repoPath);
  signals.testDirs = Array.from(new Set(
    files
      .filter((f) => /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/i.test(f))
      .map((f) => f.split("/").slice(0, 2).join("/"))
  )).slice(0, 20);
  signals.testFiles = files.filter((f) => /\.(test|spec)\.[jt]sx?$|(^|\/)tests?\/.+\.(py|go|java|rb|php|cs)$/i.test(f)).slice(0, 80);
  signals.configFiles = files.filter((f) =>
    /(^|\/)(playwright\.config|vitest\.config|jest\.config|cypress\.config|pytest\.ini|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|gradlew\.bat)/i.test(f)
  ).slice(0, 30);
  signals.sourceDirs = Array.from(new Set(
    files
      .filter((f) => /^(src|app|api|server|services|routes|controllers|tests?)\//i.test(f))
      .map((f) => f.split("/")[0])
  )).slice(0, 12);

  return signals;
}

function buildNodeRecommendedCommands(repoPath, pkg = {}) {
  const scripts = pkg?.scripts || {};
  const commands = [];

  const scriptPriority = [
    "test:ci",
    "test:unit",
    "test:integration",
    "test:e2e",
    "test:api",
    "test",
  ];

  for (const scriptName of scriptPriority) {
    if (!scripts[scriptName]) continue;
    commands.push(scriptName === "test" ? "npm test -- --runInBand" : `npm run ${scriptName}`);
  }

  if (fileExists(path.join(repoPath, "playwright.config.js")) || fileExists(path.join(repoPath, "playwright.config.ts"))) {
    commands.push("npx playwright test --reporter=line");
  }
  if (fileExists(path.join(repoPath, "vitest.config.js")) || fileExists(path.join(repoPath, "vitest.config.ts"))) {
    commands.push("npx vitest run");
  }
  if (fileExists(path.join(repoPath, "jest.config.js")) || fileExists(path.join(repoPath, "jest.config.ts"))) {
    commands.push("npx jest --runInBand");
  }

  return dedupeCommands(commands, 6);
}

function buildDeterministicRepoTestPlan(repoPath, task, framework, signals = collectRepoSignals(repoPath)) {
  const taskTokens = tokenize(`${task?.task || ""} ${task?.description || ""}`);
  const focusAreas = [];
  const commands = [];

  if (framework === "node") {
    commands.push(...buildNodeRecommendedCommands(repoPath, signals.packageJson || {}));
    if (signals.testFiles.some((f) => /playwright|e2e|cypress/i.test(f))) focusAreas.push("e2e");
    if (signals.testFiles.some((f) => /api|integration/i.test(f))) focusAreas.push("integration");
    if (signals.testFiles.some((f) => /unit|spec|test/i.test(f))) focusAreas.push("unit");
  } else if (framework === "python") {
    if (signals.testDirs.some((d) => /tests\/unit|test\/unit/i.test(d))) commands.push("pytest tests/unit -q");
    commands.push("pytest -q");
    if (fileExists(path.join(repoPath, "bandit.yml")) || signals.rootFiles.includes("requirements.txt")) commands.push("bandit -r . -ll");
    focusAreas.push("pytest");
  } else if (framework === "go") {
    commands.push("go test ./...");
    focusAreas.push("go test");
  } else if (framework === "maven") {
    commands.push("mvn -q test");
    focusAreas.push("maven");
  } else if (framework === "gradle") {
    commands.push("gradlew.bat test");
    focusAreas.push("gradle");
  }

  const matchedFiles = signals.testFiles.filter((file) =>
    taskTokens.some((token) => token.length >= 4 && file.toLowerCase().includes(token))
  ).slice(0, 6);
  if (matchedFiles.length > 0) {
    focusAreas.push(...matchedFiles);
  } else if (signals.testDirs.length > 0) {
    focusAreas.push(...signals.testDirs.slice(0, 4));
  } else if (signals.sourceDirs.length > 0) {
    focusAreas.push(...signals.sourceDirs.slice(0, 4));
  }

  return {
    commands: dedupeCommands(commands, 6),
    rationale: "Deterministic plan derived from package scripts, test/config files, and repo structure",
    focusAreas: Array.from(new Set(focusAreas)).slice(0, 8),
    signals,
  };
}

function detectFramework(repoPath) {
  if (!isDirectory(repoPath)) return { framework: "unknown", recommendedCommands: [] };

  const packageJsonPath = path.join(repoPath, "package.json");
  if (fileExists(packageJsonPath)) {
    const pkg = readJsonFileSafe(packageJsonPath);
    const commands = buildNodeRecommendedCommands(repoPath, pkg || {});
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
      safeJsonStringify(generatedCases),
      safeJsonStringify(commands),
      safeJsonStringify({}),
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
    [runId, status, safeJsonStringify(outputJson || {})]
  );
  return rows[0];
}

function normalizeRunRow(row) {
  return {
    ...row,
    generated_cases: parseJsonMaybe(row.generated_cases, []),
    commands: parseJsonMaybe(row.commands, []),
    output_json: parseJsonMaybe(row.output_json, {}),
  };
}

async function maybeAttachReportDocument(row) {
  const normalized = normalizeRunRow(row);
  const status = String(normalized.status || "").toLowerCase();
  if (["running", "pending", "cancel_requested"].includes(status)) {
    return normalized;
  }
  // If a professional markdownReport exists but the cached reportDocument was built
  // before we used it (title is the old generic title), regenerate so the PDF and
  // report endpoint serve the proper QA report.
  const hasMarkdownReport = typeof normalized.output_json?.markdownReport === "string" && normalized.output_json.markdownReport.length > 100;
  const cachedDoc = normalized.output_json?.reportDocument;
  const cachedUsesMarkdown = cachedDoc?.title === "QA Test Report";
  if (cachedDoc && (!hasMarkdownReport || cachedUsesMarkdown)) {
    return normalized;
  }
  const reportDocument = buildRunReportDocument(normalized);
  const outputJson = {
    ...normalized.output_json,
    reportDocument,
  };
  await pool.query(
    `UPDATE testing_agent_runs SET output_json = $2 WHERE id = $1`,
    [normalized.id, safeJsonStringify(outputJson)]
  ).catch(() => {});
  return {
    ...normalized,
    output_json: outputJson,
  };
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
  const runController = createRunController(run.id);

  // Execute commands with live updates + streaming + retry + per-command AI analysis
  const commandOutputs = [];
  try {
    for (const cmd of finalCommands) {
      await runController.assertActive({ phase: "command_start", command: cmd });
      const output = await executeCommandWithRetry(
        cmd,
        settings.max_runtime_seconds,
        executionContext.repoPath,
        async (liveStdout) => {
          await updateRunLive(run.id, [
            ...commandOutputs,
            { command: cmd, status: "running", stdout: liveStdout, stderr: "", passed: false, timedOut: false, cancelled: false, durationMs: 0 },
          ]);
        },
        runController
      );

      if (output.cancelled) {
        throw new RunCancelledError("Run stopped by user", { command: cmd });
      }

      if (!output.passed) {
        output.aiAnalysis = await aiAnalyzeCliFailure(
          cmd, output.stdout, output.stderr, executionContext.framework
        );
      }

      commandOutputs.push(output);
      await updateRunLive(run.id, commandOutputs);

      if (stopOnFirstFailure && !output.passed) break;
    }
  } catch (error) {
    if (isRunCancelledError(error)) {
      const outputJson = {
        gitContext,
        executionContext,
        commandOutputs,
        generatedCases,
        summary: {
          commandCount: finalCommands.length,
          executedCount: commandOutputs.length,
          passed: false,
          cancelled: true,
          failureReason: error.message,
        },
      };
      await finishRun(run.id, {
        status: "cancelled",
        outputJson,
      });
      return {
        runId: run.id,
        status: "cancelled",
        generatedCases,
        commands: finalCommands,
        output: outputJson,
      };
    }
    throw error;
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
function parseOpenApiSpec(openApiSpec) {
  if (!openApiSpec) return null;
  if (typeof openApiSpec === "object") return openApiSpec;
  try {
    return JSON.parse(String(openApiSpec));
  } catch {
    return null;
  }
}

function sampleValueFromSchema(schema, depth = 0) {
  if (!schema || depth > 3) return "sample";
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.format === "uuid") return "00000000-0000-0000-0000-000000000001";
  if (schema.format === "email") return "qa@example.com";
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [sampleValueFromSchema(schema.items || {}, depth + 1)];
  if (schema.type === "object" || schema.properties) {
    const out = {};
    for (const [key, value] of Object.entries(schema.properties || {}).slice(0, 6)) {
      out[key] = sampleValueFromSchema(value, depth + 1);
    }
    return out;
  }
  return "sample";
}

function resolveSchemaRef(spec, schema) {
  if (!schema?.$ref || !spec?.components?.schemas) return schema;
  const refName = String(schema.$ref).split("/").pop();
  return spec.components.schemas?.[refName] || schema;
}

function extractJsonSchema(content = {}, spec = null) {
  const schema =
    content?.["application/json"]?.schema ||
    content?.["application/*+json"]?.schema ||
    null;
  return resolveSchemaRef(spec, schema);
}

function extractResponseFieldNames(operation, spec) {
  const responses = operation?.responses || {};
  const successKey = Object.keys(responses).find((key) => /^2\d\d$/.test(key)) || Object.keys(responses)[0];
  if (!successKey) return [];
  const schema = extractJsonSchema(responses[successKey]?.content || {}, spec);
  const resolved = resolveSchemaRef(spec, schema);
  return Object.keys(resolved?.properties || {}).slice(0, 8);
}

function buildRequestBody(operation, spec) {
  const schema = extractJsonSchema(operation?.requestBody?.content || {}, spec);
  const resolved = resolveSchemaRef(spec, schema);
  if (!resolved) return null;
  return sampleValueFromSchema(resolved);
}

function buildApiPlanFromOpenApi(task, openApiSpec) {
  const spec = parseOpenApiSpec(openApiSpec);
  if (!spec?.paths || typeof spec.paths !== "object") return null;

  const taskTokens = tokenize(`${task?.task || ""} ${task?.description || ""}`);
  const operations = [];

  for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (!pathItem?.[method]) continue;
      const operation = pathItem[method];
      const text = `${rawPath} ${operation.summary || ""} ${operation.description || ""}`.toLowerCase();
      const score = taskTokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
      operations.push({ path: rawPath, method: method.toUpperCase(), operation, score });
    }
  }

  const selected = operations
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 6);

  if (selected.length === 0) return null;

  const plan = [];
  let index = 1;
  const nextId = () => `AT-${String(index++).padStart(3, "0")}`;

  for (const item of selected) {
    const expectedFields = extractResponseFieldNames(item.operation, spec);
    const requestBody = buildRequestBody(item.operation, spec);
    const successStatus = Number(
      Object.keys(item.operation?.responses || {}).find((key) => /^2\d\d$/.test(key)) ||
      (item.method === "POST" ? 201 : 200)
    );
    const validationStatus = Number(
      Object.keys(item.operation?.responses || {}).find((key) => /^(400|422)$/.test(key)) || 400
    );
    const unauthorizedStatus = Number(
      Object.keys(item.operation?.responses || {}).find((key) => /^(401|403)$/.test(key)) || 401
    );
    const securityEnabled = Boolean(
      (Array.isArray(item.operation?.security) && item.operation.security.length) ||
      (Array.isArray(spec.security) && spec.security.length)
    );

    plan.push({
      id: nextId(),
      name: `${item.method} ${item.path} happy path`,
      method: item.method,
      path: item.path.replace(/\{[^}]+\}/g, "1"),
      headers: {},
      body: requestBody,
      expectedStatus: successStatus,
      expectedFields,
      description: item.operation.summary || `Validate ${item.method} ${item.path}`,
    });

    if (requestBody && ["POST", "PUT", "PATCH"].includes(item.method)) {
      plan.push({
        id: nextId(),
        name: `${item.method} ${item.path} validation`,
        method: item.method,
        path: item.path.replace(/\{[^}]+\}/g, "1"),
        headers: {},
        body: {},
        expectedStatus: validationStatus,
        expectedFields: [],
        description: "Reject invalid or incomplete payload",
      });
    }

    if (/\{[^}]+\}/.test(item.path)) {
      plan.push({
        id: nextId(),
        name: `${item.method} ${item.path} not found`,
        method: item.method,
        path: item.path.replace(/\{[^}]+\}/g, "999999"),
        headers: {},
        body: requestBody,
        expectedStatus: 404,
        expectedFields: [],
        description: "Unknown resource should return not found",
      });
    }

    if (securityEnabled) {
      plan.push({
        id: nextId(),
        name: `${item.method} ${item.path} unauthorized`,
        method: item.method,
        path: item.path.replace(/\{[^}]+\}/g, "1"),
        headers: { Authorization: "" },
        body: requestBody,
        expectedStatus: unauthorizedStatus,
        expectedFields: [],
        description: "Protected endpoint should reject missing auth",
      });
    }
  }

  return plan.slice(0, 12);
}

async function generateApiTestPlan(task, baseUrl, openApiSpec = null) {
  const deterministicPlan = buildApiPlanFromOpenApi(task, openApiSpec);
  if (Array.isArray(deterministicPlan) && deterministicPlan.length > 0) {
    return deterministicPlan;
  }

  const taskTitle = task?.task || "";
  const brief = buildTaskTestingBrief({ task, gitContext: { changedFiles: [] }, fileContents: {} });
  const specContext = openApiSpec ? `API Spec (partial): ${JSON.stringify(openApiSpec).slice(0, 800)}` : "";
  const prompt = `QA engineer. Generate 6-10 HTTP API test scenarios for this task.

TASK: "${taskTitle}"
BASE URL: ${baseUrl}
ACCEPTANCE SIGNALS:
${brief.acceptanceSignals.map((item) => `- ${item}`).join("\n") || "- infer from task title"}
RELATED RISKS:
${brief.linkedRisks.map((item) => `- ${item}`).join("\n") || "- none"}
${specContext}

Return ONLY this JSON array:
[{"id":"AT-001","name":"...","method":"GET|POST|PUT|DELETE|PATCH","path":"/api/...","headers":{},"body":null,"expectedStatus":200,"expectedFields":["field1","field2"],"description":"..."},...]

Rules:
- Cover: happy path, validation errors (400), auth errors (401/403), not found (404), server errors (500)
- body should be a JSON object (or null for GET)
- expectedFields: top-level fields expected in JSON response
- paths must be realistic for "${taskTitle}"
- include follow-through checks for side effects or linked workflows when the task suggests them
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
  const runController = createRunController(run.id);

  const stepResults = [];
  try {
    for (const step of testPlan) {
      await runController.assertActive({ phase: "api_step", name: step.name });
      const result = await executeApiStep(step, baseUrl, authToken);
      stepResults.push(result);
      await pool.query(
        `UPDATE testing_agent_runs SET output_json = jsonb_set(COALESCE(output_json,'{}'), '{stepResults}', $2::jsonb) WHERE id = $1`,
        [run.id, safeJsonStringify(stepResults)]
      ).catch(() => {});
    }
  } catch (error) {
    if (isRunCancelledError(error)) {
      const outputJson = {
        baseUrl,
        testPlan,
        stepResults,
        summary: {
          total: stepResults.length,
          passed: stepResults.filter((step) => step.status === "passed").length,
          failed: stepResults.filter((step) => step.status === "failed").length,
          cancelled: true,
        },
      };
      await finishRun(run.id, { status: "cancelled", outputJson });
      return {
        runId: run.id,
        status: "cancelled",
        baseUrl,
        testPlan,
        stepResults,
        summary: outputJson.summary,
      };
    }
    throw error;
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
  const deterministicPlan = buildDeterministicRepoTestPlan(repoPath, task, framework);
  const signals = deterministicPlan.signals || collectRepoSignals(repoPath);

  const taskTitle = task?.task || "";
  const brief = buildTaskTestingBrief({ task, gitContext: { changedFiles: [] }, fileContents: {} });
  const prompt = `You are a QA engineer auto-discovering tests for a codebase.

TASK: "${taskTitle}"
REPO PATH: ${repoPath}
ACCEPTANCE SIGNALS: ${brief.acceptanceSignals.join(" | ") || "infer from task title"}
RELATED RISKS: ${brief.linkedRisks.join(" | ") || "none"}
ACCEPTANCE SIGNALS: ${brief.acceptanceSignals.join(" | ") || "infer from task title"}
RELATED RISKS: ${brief.linkedRisks.join(" | ") || "none"}
FRAMEWORK: ${framework}
REPO SIGNALS: ${JSON.stringify(signals).slice(0, 600)}
DETERMINISTIC BASE COMMANDS: ${deterministicPlan.commands.join(", ") || "none"}

Generate a test execution plan: 3-6 specific commands to run in this repo.
Consider: existing test scripts, framework conventions, what files to target, and what downstream areas the task can affect.
Prefer refining the deterministic base commands instead of inventing new tooling.

Return ONLY this JSON:
{
  "commands": ["cmd1","cmd2","cmd3"],
  "rationale": "why these commands",
  "focusAreas": ["area1","area2"]
}`;

  try {
    const raw = await generateText({ prompt, maxTokens: 600 });
    const plan = parseJsonSafe(raw, null);
    if (plan?.commands && Array.isArray(plan.commands) && plan.commands.length > 0) {
      return {
        commands: dedupeCommands([...deterministicPlan.commands, ...plan.commands], 6),
        rationale: plan.rationale || deterministicPlan.rationale,
        focusAreas: Array.from(new Set([...(deterministicPlan.focusAreas || []), ...(Array.isArray(plan.focusAreas) ? plan.focusAreas : [])])).slice(0, 8),
        signals,
      };
    }
  } catch { /* fallback */ }

  return {
    commands: deterministicPlan.commands.length ? deterministicPlan.commands : ["npm test -- --runInBand"],
    rationale: deterministicPlan.rationale,
    focusAreas: deterministicPlan.focusAreas || [],
    signals,
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
  const runController = createRunController(run.id);

  // Phase 2: Execute discovered commands with live updates + retry
  const commandOutputs = [];
  try {
    for (const cmd of discoveredPlan.commands) {
      await runController.assertActive({ phase: "command_start", command: cmd });
      const output = await executeCommandWithRetry(
        cmd, settings.max_runtime_seconds, executionContext.repoPath,
        async (liveStdout) => {
          await updateRunLive(run.id, [
            ...commandOutputs,
            { command: cmd, status: "running", stdout: liveStdout, stderr: "", passed: false, timedOut: false, cancelled: false, durationMs: 0 },
          ]);
        },
        runController
      );
      if (output.cancelled) {
        throw new RunCancelledError("Run stopped by user", { command: cmd });
      }
      if (!output.passed) {
        output.aiAnalysis = await aiAnalyzeCliFailure(cmd, output.stdout, output.stderr, executionContext.framework);
      }
      commandOutputs.push(output);
      await updateRunLive(run.id, commandOutputs);
    }
  } catch (error) {
    if (isRunCancelledError(error)) {
      const outputJson = {
        discoveredPlan,
        gitContext,
        generatedCases,
        commandOutputs,
        summary: {
          commandCount: discoveredPlan.commands.length,
          executedCount: commandOutputs.length,
          passed: false,
          cancelled: true,
          failureReason: error.message,
        },
      };
      await finishRun(run.id, { status: "cancelled", outputJson });
      return {
        runId: run.id,
        status: "cancelled",
        discoveredPlan,
        generatedCases,
        summary: outputJson.summary,
      };
    }
    throw error;
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
  const brief = buildTaskTestingBrief({ task, gitContext: { changedFiles: [] }, fileContents: {} });

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
    const runController = createRunController(run.id);

    const commandOutputs = [];
    try {
      for (const cmd of cmds) {
        await runController.assertActive({ phase: "command_start", command: cmd });
        const output = await executeCommandWithRetry(
          cmd, settings.max_runtime_seconds, executionContext.repoPath,
          async (liveStdout) => {
            await updateRunLive(run.id, [
              ...commandOutputs,
              { command: cmd, status: "running", stdout: liveStdout, stderr: "", passed: false, timedOut: false, cancelled: false, durationMs: 0 },
            ]);
          },
          runController
        );
        if (output.cancelled) {
          throw new RunCancelledError("Run stopped by user", { command: cmd });
        }
        if (!output.passed) {
          output.aiAnalysis = await aiAnalyzeCliFailure(cmd, output.stdout, output.stderr, executionContext.framework);
        }
        commandOutputs.push(output);
        await updateRunLive(run.id, commandOutputs);
      }
    } catch (error) {
      if (isRunCancelledError(error)) {
        await finishRun(run.id, {
          status: "cancelled",
          outputJson: {
            scenarioType: type,
            scenarioLabel: LABELS[type],
            commandOutputs,
            generatedCases,
            summary: {
              total: commandOutputs.length,
              passed: commandOutputs.filter((command) => command.passed).length,
              failed: commandOutputs.filter((command) => !command.passed).length,
              cancelled: true,
            },
          },
        });
        scenarioResults.push({
          runId: run.id,
          type,
          label: LABELS[type],
          status: "cancelled",
          commands: cmds,
          summary: {
            total: commandOutputs.length,
            passed: commandOutputs.filter((command) => command.passed).length,
            failed: commandOutputs.filter((command) => !command.passed).length,
          },
        });
        break;
      }
      throw error;
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
      r.id,
      r.workspace_id,
      r.project_id,
      r.task_id,
      r.trigger_source,
      r.mode,
      r.status,
      r.created_at,
      r.finished_at,
      r.created_by,
      r.commands,
      jsonb_array_length(COALESCE(r.generated_cases, '[]'::jsonb)) AS generated_cases_count,
      -- Extract lightweight summary fields from JSONB without loading full blob
      r.output_json->'summary'             AS summary,
      r.output_json->'insights'            AS insights,
      r.output_json->>'markdownReport'     AS markdown_report_preview,
      r.output_json->'allBugs'             AS all_bugs,
      r.output_json->'discoveredModules'   AS discovered_modules,
      r.output_json->'phases'              AS phases,
      t.task  AS task_name,
      p.name  AS project_name
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
    id: r.id,
    workspace_id: r.workspace_id,
    project_id: r.project_id,
    task_id: r.task_id,
    trigger_source: r.trigger_source,
    mode: r.mode,
    status: r.status,
    created_at: r.created_at,
    finished_at: r.finished_at,
    created_by: r.created_by,
    task_name: r.task_name,
    project_name: r.project_name,
    commands: parseJsonMaybe(r.commands, []),
    generated_cases_count: Number(r.generated_cases_count || 0),
    summary: parseJsonMaybe(r.summary, null),
    insights: parseJsonMaybe(r.insights, null),
    allBugs: parseJsonMaybe(r.all_bugs, []),
    discoveredModules: parseJsonMaybe(r.discovered_modules, []),
    phases: parseJsonMaybe(r.phases, null),
    // markdownReport excluded from list — only in detail endpoint
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
  return maybeAttachReportDocument(rows[0]);
}

export async function stopTestingAgentRun({
  workspaceId,
  runId,
  actorId = null,
  reason = "Stopped by user",
}) {
  return requestTestingRunStop({ workspaceId, runId, actorId, reason });
}

export async function getTestingAgentRunReport({
  workspaceId,
  runId,
}) {
  const run = await getTestingAgentRunById({ workspaceId, runId });
  if (!run) return null;
  const reportDocument = run.output_json?.reportDocument || buildRunReportDocument(run);
  return {
    runId: run.id,
    status: run.status,
    mode: run.mode,
    taskName: run.task_name || null,
    projectName: run.project_name || null,
    reportDocument,
  };
}

export async function getTestingAgentRunReportPdf({
  workspaceId,
  runId,
}) {
  const report = await getTestingAgentRunReport({ workspaceId, runId });
  if (!report) return null;
  const filename = `testing-agent-report-${runId}.pdf`;
  const pdf = buildPdfBufferFromReport(report.reportDocument, {
    title: report.reportDocument?.title || "Testing Agent Execution Report",
    metadata: [
      `Run ID: ${runId}`,
      `Mode: ${report.mode}`,
      `Status: ${report.status}`,
      `Task: ${report.taskName || "-"}`,
      `Project: ${report.projectName || "-"}`,
    ],
  });
  return {
    filename,
    buffer: pdf,
    reportDocument: report.reportDocument,
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
