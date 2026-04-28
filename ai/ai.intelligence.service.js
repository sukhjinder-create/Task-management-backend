import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";
import { buildAIContext } from "./ai.context.builder.js";

function detectQuestionIntent(question = "") {
  const raw = String(question || "").toLowerCase();
  const q = raw
    .replace(/\bsinged\b/g, "signed")
    .replace(/\bsignin\b/g, "sign in")
    .replace(/\blogin\b/g, "log in")
    .replace(/\bpeoples\b/g, "people")
    .replace(/\bavail\b/g, "available");
  const compact = q.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const isAttendance = /(attendance|signed in|signed-in|available|availability|aws|lunch|online|present|absent|who is|who's|how many people|headcount|check in|clock in)/i.test(compact);
  const asksCount = /(how many|count|number|total)/i.test(q);
  const asksTimes = /(how many times|times|frequency|occurrences|no\.?\s*of\s*times)/i.test(q);
  const asksDuration = /(how much time|total time|duration|for how long|minutes|hours)/i.test(q);
  const asksNames = /(who|names?|list|which users?|which people|tell me.*names?)/i.test(q);
  const asksSignedIn = /signed in|sign(ed)?-?in|checked in|check(ed)?-?in|logged in|log(ed)?-?in|present today/i.test(q);
  const asksSignedInToday = /(signed in|sign(ed)?-?in|checked in|check(ed)?-?in|logged in|log(ed)?-?in).*(today)|today.*(signed in|sign(ed)?-?in|checked in|check(ed)?-?in|logged in|log(ed)?-?in)|who has signed in today/i.test(q);
  const asksAws = /\baws\b|away\b|away from screen/i.test(q);
  const asksLunch = /\blunch\b|break/i.test(q);
  const asksAvailable = /\bavailable\b|online\b|active\b/i.test(q);
  const asksRealtime = /(now|right now|currently|real[- ]?time|at the moment)/i.test(q);
  const asksOverdue = /\boverdue\b|past due|delayed|delay/i.test(compact);
  const asksCompleted = /\bcompleted\b|\bdone\b|\bclosed\b|finished/i.test(compact);
  const asksPending = /\bpending\b|not started|todo|to do/i.test(compact);
  const asksInProgress = /in progress|in-progress|ongoing|wip|work in progress/i.test(compact);
  const asksTop = /\btop\b|highest|worst|most/i.test(compact);
  const asksProjectHealth = /\bproject health\b|project performance|which project/i.test(compact);
  const asksTaskSummary = /task summary|tasks summary|status summary|summary of tasks|overall status/i.test(compact);
  const asksUserStats = /\buser\b|person|member|employee|for\s+\w+|of\s+\w+/.test(compact);

  return {
    isAttendance,
    asksCount,
    asksTimes,
    asksDuration,
    asksNames,
    asksSignedIn,
    asksSignedInToday,
    asksAws,
    asksLunch,
    asksAvailable,
    asksRealtime,
    asksOverdue,
    asksCompleted,
    asksPending,
    asksInProgress,
    asksTop,
    asksProjectHealth,
    asksTaskSummary,
    asksUserStats,
  };
}

function formatNames(names = []) {
  if (!Array.isArray(names) || names.length === 0) return "none";
  return names.join(", ");
}

function sanitizeForReadableLLM(value) {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForReadableLLM(v));
  }
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lk = k.toLowerCase();
    const isIdField =
      lk === "id" ||
      lk.endsWith("_id") ||
      lk.startsWith("id_");
    if (isIdField) {
      continue;
    }
    out[k] = sanitizeForReadableLLM(v);
  }
  return out;
}

function parseDateWindow(question = "") {
  const q = String(question || "").toLowerCase();
  if (/\btoday\b/.test(q)) {
    return { label: "today", from: "CURRENT_DATE", to: "CURRENT_DATE", mode: "sql" };
  }
  if (/yesterday/.test(q)) {
    return { label: "yesterday", from: "CURRENT_DATE - INTERVAL '1 day'", to: "CURRENT_DATE - INTERVAL '1 day'", mode: "sql" };
  }
  if (/last\s+7\s+days|past\s+7\s+days/.test(q)) {
    return { label: "last 7 days", from: "CURRENT_DATE - INTERVAL '6 days'", to: "CURRENT_DATE", mode: "sql" };
  }
  if (/this\s+week/.test(q)) {
    return { label: "this week", from: "date_trunc('week', NOW())::date", to: "CURRENT_DATE", mode: "sql" };
  }
  if (/last\s+week/.test(q)) {
    return { label: "last week", from: "(date_trunc('week', NOW())::date - INTERVAL '7 days')", to: "(date_trunc('week', NOW())::date - INTERVAL '1 day')", mode: "sql" };
  }
  if (/this\s+month/.test(q)) {
    return { label: "this month", from: "date_trunc('month', NOW())::date", to: "CURRENT_DATE", mode: "sql" };
  }
  if (/last\s+month/.test(q)) {
    return { label: "last month", from: "(date_trunc('month', NOW())::date - INTERVAL '1 month')", to: "(date_trunc('month', NOW())::date - INTERVAL '1 day')", mode: "sql" };
  }
  if (/all\s*time|overall|lifetime|ever/.test(q)) {
    return { label: "all time", mode: "all" };
  }
  return { label: "last 30 days", from: "CURRENT_DATE - INTERVAL '29 days'", to: "CURRENT_DATE", mode: "sql" };
}

function normalizeToken(v = "") {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveTargetUser(workspaceId, question = "") {
  const q = String(question || "");
  const lower = q.toLowerCase();

  const emailMatch = lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (emailMatch?.[0]) {
    const { rows } = await pool.query(
      `SELECT id, username, email FROM users WHERE workspace_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [workspaceId, emailMatch[0]]
    );
    if (rows[0]) return rows[0];
  }

  const mentionMatch = lower.match(/@([a-z0-9._-]+)/i);
  if (mentionMatch?.[1]) {
    const mention = mentionMatch[1];
    const { rows } = await pool.query(
      `SELECT id, username, email FROM users WHERE workspace_id = $1 AND LOWER(username) = LOWER($2) LIMIT 1`,
      [workspaceId, mention]
    );
    if (rows[0]) return rows[0];
  }

  const { rows: users } = await pool.query(
    `SELECT id, username, email FROM users WHERE workspace_id = $1`,
    [workspaceId]
  );
  if (!users.length) return null;

  const normalizedQ = normalizeToken(lower);
  let best = null;
  let bestScore = 0;

  for (const u of users) {
    const uname = String(u.username || "");
    const unameLower = uname.toLowerCase();
    const unameNorm = normalizeToken(unameLower);

    let score = 0;
    if (lower.includes(unameLower)) score += 4;
    if (unameNorm && normalizedQ.includes(unameNorm)) score += 4;
    const parts = unameLower.split(/[\s._-]+/).filter((p) => p.length >= 3);
    for (const p of parts) {
      if (lower.includes(p)) score += 1;
    }

    if (score > bestScore) {
      best = u;
      bestScore = score;
    }
  }

  return bestScore >= 4 ? best : null;
}

async function fetchUserAttendanceAggregate({ workspaceId, userId, kind, window }) {
  const eventType = kind === "aws" ? "AWS_START" : "LUNCH_START";
  const minutesColumn = kind === "aws" ? "aws_minutes" : "lunch_minutes";

  if (window.mode === "all") {
    const [countRes, durationRes] = await Promise.all([
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM attendance_events
        WHERE workspace_id = $1
          AND user_id = $2
          AND event_type = $3
        `,
        [workspaceId, userId, eventType]
      ),
      pool.query(
        `
        SELECT COALESCE(SUM(${minutesColumn}), 0)::int AS minutes
        FROM attendance_daily
        WHERE workspace_id = $1
          AND user_id = $2
        `,
        [workspaceId, userId]
      ),
    ]);
    return {
      count: Number(countRes.rows[0]?.count || 0),
      minutes: Number(durationRes.rows[0]?.minutes || 0),
    };
  }

  const [countRes, durationRes] = await Promise.all([
    pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM attendance_events
      WHERE workspace_id = $1
        AND user_id = $2
        AND event_type = $3
        AND started_at::date >= ${window.from}
        AND started_at::date <= ${window.to}
      `,
      [workspaceId, userId, eventType]
    ),
    pool.query(
      `
      SELECT COALESCE(SUM(${minutesColumn}), 0)::int AS minutes
      FROM attendance_daily
      WHERE workspace_id = $1
        AND user_id = $2
        AND date >= ${window.from}
        AND date <= ${window.to}
      `,
      [workspaceId, userId]
    ),
  ]);

  return {
    count: Number(countRes.rows[0]?.count || 0),
    minutes: Number(durationRes.rows[0]?.minutes || 0),
  };
}

function formatDuration(minutes = 0) {
  const mins = Math.max(0, Number(minutes || 0));
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs <= 0) return `${rem} minute(s)`;
  return `${hrs}h ${rem}m`;
}

async function buildAttendanceAnalyticsAnswer({ workspaceId, question }) {
  const intent = detectQuestionIntent(question);
  const asksAws = !!intent.asksAws;
  const asksLunch = !!intent.asksLunch;
  const wantsAnalytics = !!(intent.asksTimes || intent.asksCount || intent.asksDuration || intent.asksUserStats);
  const kind = asksAws ? "aws" : asksLunch ? "lunch" : null;
  if (!kind || !wantsAnalytics) return null;

  const user = await resolveTargetUser(workspaceId, question);
  if (!user) {
    return `Please specify the user name for ${kind.toUpperCase()} analytics (example: "How many times did Sarah take ${kind} this month?").`;
  }

  const window = parseDateWindow(question);
  const agg = await fetchUserAttendanceAggregate({
    workspaceId,
    userId: user.id,
    kind,
    window,
  });

  const label = kind.toUpperCase();
  if (intent.asksDuration && !intent.asksTimes && !intent.asksCount) {
    return `${label} total time for ${user.username} (${window.label}): ${formatDuration(agg.minutes)}.`;
  }
  if ((intent.asksTimes || intent.asksCount) && !intent.asksDuration) {
    return `${label} count for ${user.username} (${window.label}): ${agg.count} time(s).`;
  }
  return `${label} summary for ${user.username} (${window.label}): ${agg.count} time(s), total ${formatDuration(agg.minutes)}.`;
}

async function buildAttendanceAnswer({ workspaceId, question, context }) {
  const intent = detectQuestionIntent(question);
  const live = context?.attendance?.live || {};
  const today = context?.attendance?.todaySignIns || {};
  const history = context?.attendance?.history30d || {};

  const available = live?.available || { count: 0, names: [], more: 0 };
  const aws = live?.aws || { count: 0, names: [], more: 0 };
  const lunch = live?.lunch || { count: 0, names: [], more: 0 };
  const totalSignedIn = Number(live?.totalSignedIn || 0);
  const liveSignedInNames = Array.from(
    new Set([...(available.names || []), ...(aws.names || []), ...(lunch.names || [])])
  );

  const lines = [];
  const generatedAt = live?.generatedAt
    ? new Date(live.generatedAt).toISOString()
    : new Date().toISOString();

  const analyticsAnswer = await buildAttendanceAnalyticsAnswer({ workspaceId, question });
  if (analyticsAnswer) {
    return `${analyticsAnswer}\nData timestamp: ${generatedAt}.`;
  }

  if (intent.asksSignedInToday) {
    lines.push(`Date: ${today.date || new Date().toISOString().slice(0, 10)}.`);
    lines.push(`Signed in today: ${Number(today.totalSignedInToday || 0)} user(s).`);
    lines.push(`Names: ${formatNames(today.names)}${today.more > 0 ? ` (+${today.more} more)` : ""}.`);
    lines.push(`Currently signed in: ${Number(today.currentlySignedIn || 0)} user(s).`);
  } else if (intent.asksSignedIn) {
    lines.push(`Currently signed in: ${totalSignedIn} user(s).`);
    lines.push(`Names: ${formatNames(liveSignedInNames)}.`);
  } else if (intent.asksAws) {
    lines.push(`AWS right now: ${aws.count} user(s).`);
    if (intent.asksNames || aws.count > 0) {
      lines.push(`Names: ${formatNames(aws.names)}${aws.more > 0 ? ` (+${aws.more} more)` : ""}.`);
    }
  } else if (intent.asksLunch) {
    lines.push(`On lunch right now: ${lunch.count} user(s).`);
    if (intent.asksNames || lunch.count > 0) {
      lines.push(`Names: ${formatNames(lunch.names)}${lunch.more > 0 ? ` (+${lunch.more} more)` : ""}.`);
    }
  } else if (intent.asksAvailable) {
    lines.push(`Available right now: ${available.count} user(s).`);
    if (intent.asksNames || available.count > 0) {
      lines.push(`Names: ${formatNames(available.names)}${available.more > 0 ? ` (+${available.more} more)` : ""}.`);
    }
  } else {
    lines.push(`Live attendance: ${totalSignedIn} signed in, ${available.count} available, ${aws.count} on AWS, ${lunch.count} on lunch.`);
    if (intent.asksNames) {
      lines.push(`AWS names: ${formatNames(aws.names)}${aws.more > 0 ? ` (+${aws.more} more)` : ""}.`);
      lines.push(`Lunch names: ${formatNames(lunch.names)}${lunch.more > 0 ? ` (+${lunch.more} more)` : ""}.`);
    }
  }

  const isSpecificAttendanceAsk =
    intent.asksAws ||
    intent.asksLunch ||
    intent.asksAvailable ||
    intent.asksSignedIn ||
    intent.asksSignedInToday ||
    intent.asksNames;

  if (!isSpecificAttendanceAsk && (!intent.asksRealtime || !intent.asksCount)) {
    lines.push(
      `30-day attendance baseline: availability ${history.availabilityRatio || 0}%, AWS ratio ${history.awsRatio || 0}%, observed users ${history.observedUsers || 0}.`
    );
  }

  lines.push(`Data timestamp: ${generatedAt}.`);
  return lines.join("\n");
}

function numberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildTaskStatusAnswer({ context, intent, scope }) {
  const summary =
    scope === "workspace"
      ? (context.workspaceSummary || {})
      : scope === "project"
        ? (context.projectSummary || {})
        : {
            total: 1,
            pending: String(context?.taskFacts?.status || "").toLowerCase() === "pending" ? 1 : 0,
            inProgress: String(context?.taskFacts?.status || "").toLowerCase() === "in-progress" ? 1 : 0,
            completed: String(context?.taskFacts?.status || "").toLowerCase() === "completed" ? 1 : 0,
            cancelled: String(context?.taskFacts?.status || "").toLowerCase() === "cancelled" ? 1 : 0,
            overdueOpen: context?.taskFacts?.isOverdue ? 1 : 0,
          };

  if (intent.asksOverdue && intent.asksTop) {
    const top = (context.topOverdueTasks || [])[0];
    if (!top) return "Top overdue task: none.";
    return `Top overdue task: "${top.task}" (${top.overdueDays} day(s) overdue)${top.projectName ? ` in ${top.projectName}` : ""}${top.assignee ? `, assignee: ${top.assignee}` : ""}.`;
  }

  if (intent.asksOverdue && intent.asksNames) {
    if (scope === "task") {
      if (!context?.taskFacts?.isOverdue) return "Overdue tasks: none.";
      return `Overdue task: "${context.task?.task || "Untitled"}" (${context.taskFacts.overdueDays} day(s) overdue)${context.taskFacts.projectName ? ` in ${context.taskFacts.projectName}` : ""}${context.taskFacts.assignee ? `, assignee: ${context.taskFacts.assignee}` : ""}.`;
    }

    const overdueList = (context.topOverdueTasks || []).slice(0, 8);
    if (!overdueList.length) return "Overdue tasks: none.";

    const formatted = overdueList
      .map((t) =>
        `"${t.task}" (${t.overdueDays}d${t.projectName ? `, ${t.projectName}` : ""}${t.assignee ? `, ${t.assignee}` : ""})`
      )
      .join("; ");

    return `Overdue tasks (${overdueList.length} shown): ${formatted}.`;
  }

  if (intent.asksOverdue) {
    return `Overdue open tasks: ${numberOrZero(summary.overdueOpen)}.`;
  }
  if (intent.asksCompleted) {
    return `Completed tasks: ${numberOrZero(summary.completed)}.`;
  }
  if (intent.asksPending) {
    return `Pending tasks: ${numberOrZero(summary.pending)}.`;
  }
  if (intent.asksInProgress) {
    return `In-progress tasks: ${numberOrZero(summary.inProgress)}.`;
  }

  return [
    `Task status summary: total ${numberOrZero(summary.total)}, pending ${numberOrZero(summary.pending)}, in-progress ${numberOrZero(summary.inProgress)}, completed ${numberOrZero(summary.completed)}, overdue ${numberOrZero(summary.overdueOpen)}.`,
    context.topOverdueTasks?.length
      ? `Top overdue: "${context.topOverdueTasks[0].task}" (${context.topOverdueTasks[0].overdueDays} day(s)).`
      : null,
  ].filter(Boolean).join("\n");
}

function buildProjectHealthAnswer({ context }) {
  const rows = context.projectHealth || [];
  if (!rows.length) return "Project health data: no projects found in current scope.";
  const topRisk = [...rows].sort((a, b) => b.overdueTasks - a.overdueTasks)[0];
  const best = [...rows].sort((a, b) => b.completionRate - a.completionRate)[0];
  return [
    `Projects in scope: ${rows.length}.`,
    `Highest risk project: ${topRisk.projectName} (${topRisk.overdueTasks} overdue, completion ${topRisk.completionRate}%).`,
    `Best completion project: ${best.projectName} (${best.completionRate}%, ${best.completedTasks}/${best.totalTasks} completed).`,
  ].join("\n");
}

function shouldUseDeterministicOpsAnswer(intent) {
  return (
    intent.asksTaskSummary ||
    intent.asksOverdue ||
    intent.asksCompleted ||
    intent.asksPending ||
    intent.asksInProgress ||
    intent.asksProjectHealth
  );
}

async function buildPersonAnswer({ workspaceId, user, question }) {
  const [taskRes, recentRes] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM tasks WHERE workspace_id = $1 AND assigned_to = $2
       GROUP BY status`,
      [workspaceId, user.id]
    ),
    pool.query(
      `SELECT t.task, t.status, t.priority, t.due_date, p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.workspace_id = $1 AND t.assigned_to = $2
       ORDER BY t.updated_at DESC LIMIT 5`,
      [workspaceId, user.id]
    ),
  ]);

  const statusCounts = Object.fromEntries(taskRes.rows.map(r => [r.status, r.count]));
  const total = taskRes.rows.reduce((s, r) => s + r.count, 0);
  const completed = (statusCounts.completed || 0) + (statusCounts.done || 0);
  const inProgress = statusCounts["in-progress"] || statusCounts.in_progress || 0;
  const pending = statusCounts.pending || statusCounts.todo || 0;

  const overdueRes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM tasks
     WHERE workspace_id = $1 AND assigned_to = $2
       AND due_date < NOW() AND status NOT IN ('done','completed')`,
    [workspaceId, user.id]
  );
  const overdue = overdueRes.rows[0]?.count || 0;

  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const lines = [
    `${user.username}: ${total} total tasks assigned (${completionRate}% completion rate).`,
    `Status — Completed: ${completed}, In Progress: ${inProgress}, Pending: ${pending}, Overdue: ${overdue}.`,
  ];

  if (recentRes.rows.length > 0) {
    const recent = recentRes.rows.map(t =>
      `"${t.task}" (${t.status}${t.project_name ? `, ${t.project_name}` : ""}${t.due_date ? `, due ${new Date(t.due_date).toDateString()}` : ""})`
    ).join("; ");
    lines.push(`Recent tasks: ${recent}.`);
  }

  if (overdue > 0) {
    lines.push(`⚠️ ${overdue} overdue task${overdue > 1 ? "s" : ""} need attention.`);
  } else if (total === 0) {
    lines.push(`No tasks assigned to ${user.username} in this workspace.`);
  }

  return lines.join("\n");
}

/**
 * Strategic Intelligence Query Service
 * Analyzes operational data and provides executive-level insights
 *
 * NOT for casual chat - for decision support
 */
export async function runAIIntelligenceQuery({
  workspaceId,
  scope,
  entityId,
  question,
}) {
  try {
    const intent = detectQuestionIntent(question);

    // Build structured context from single source of truth.
    const context = await buildAIContext({
      workspaceId,
      scope,
      entityId,
      question,
    });

    // Attendance-heavy questions should be deterministic and real-time.
    if (intent.isAttendance) {
      return await buildAttendanceAnswer({ workspaceId, question, context });
    }

    if (shouldUseDeterministicOpsAnswer(intent)) {
      if (intent.asksProjectHealth && (context.scope === "workspace" || context.scope === "project")) {
        return buildProjectHealthAnswer({ context });
      }
      return buildTaskStatusAnswer({ context, intent, scope });
    }

    // Person-specific question in workspace scope — resolve and return member summary
    if (scope === "workspace" || scope === "project") {
      const targetUser = await resolveTargetUser(workspaceId, question);
      if (targetUser) {
        const answer = await buildPersonAnswer({ workspaceId, user: targetUser, question });
        if (answer) return answer;
      }
    }

    const contextForLlm = sanitizeForReadableLLM(context);
    const contextJson = JSON.stringify(contextForLlm, null, 2);

    const prompt = `
You are Strategic Intelligence inside an enterprise operations platform.

This is NOT casual chat. This is operational analytics for decisions.

User Question:
"${question}"

Scope: ${scope}

Structured Context:
${contextJson}

Instructions:
- Start with a direct answer in one sentence.
- Then add exactly 2 to 5 bullet points with concrete facts from context.
- Include numbers and entity names when available.
- If data is insufficient, say exactly what is missing.
- Do not repeat generic recommendations.
- Do not add introductions or filler.
- Keep language readable and specific.
- Interpret flexible/colloquial wording correctly and answer the user's actual intent.
- Never show raw IDs/UUIDs in the answer unless user explicitly asks for IDs.
- Max 170 words.
`;

    console.log(`AI Intelligence Query:\n  - Scope: ${scope}\n  - EntityId: ${entityId || "N/A"}\n  - Question length: ${question.length} chars\n  - Context size: ${contextJson.length} chars\n  - Total prompt size: ${prompt.length} chars`);

    if (prompt.length > 50000) {
      console.warn(`Prompt size (${prompt.length}) exceeds safe limit. Truncating context...`);
      throw new Error("Context too large. Please narrow your query scope.");
    }

    try {
      const answer = await generateText({ prompt });
      if (answer) return String(answer).trim();
    } catch (llmErr) {
      console.warn("AI Intelligence LLM unavailable, using deterministic fallback:", llmErr.message);
    }

    // LLM unavailable — build a deterministic answer from context data
    return buildFallbackAnswer({ context, scope });
  } catch (error) {
    console.error("AI Intelligence Query Failed:", error.message);
    throw error;
  }
}

function buildFallbackAnswer({ context, scope }) {
  const lines = [];
  const ws = context.workspaceSummary || {};
  const proj = context.projectSummary || {};
  const task = context.taskFacts || {};

  if (scope === "task") {
    lines.push(`Task: "${context.task?.task || "Untitled"}"`);
    lines.push(`Status: ${task.status || "unknown"} | Priority: ${task.priority || "unset"} | Assignee: ${task.assignee || "unassigned"}`);
    if (task.isOverdue) lines.push(`Overdue by ${task.overdueDays || "?"} day(s).`);
    if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
    if (context.task?.description) lines.push(`Description: ${String(context.task.description).slice(0, 200)}`);
  } else if (scope === "project") {
    const p = context.project || {};
    lines.push(`Project: ${p.name || "Unknown"}`);
    lines.push(`Tasks: ${proj.total || 0} total — ${proj.completed || 0} done, ${proj.inProgress || 0} in progress, ${proj.pending || 0} pending, ${proj.overdueOpen || 0} overdue.`);
    if ((context.topOverdueTasks || []).length) {
      lines.push(`Top overdue: "${context.topOverdueTasks[0].task}" (${context.topOverdueTasks[0].overdueDays}d overdue${context.topOverdueTasks[0].assignee ? `, ${context.topOverdueTasks[0].assignee}` : ""}).`);
    }
  } else {
    lines.push(`Workspace tasks: ${ws.total || 0} total — ${ws.completed || 0} done, ${ws.inProgress || 0} in progress, ${ws.pending || 0} pending, ${ws.overdueOpen || 0} overdue.`);
    if ((context.projectHealth || []).length) {
      const sorted = [...context.projectHealth].sort((a, b) => b.overdueTasks - a.overdueTasks);
      lines.push(`Highest risk project: ${sorted[0].projectName} (${sorted[0].overdueTasks} overdue, ${sorted[0].completionRate}% complete).`);
    }
    if ((context.topOverdueTasks || []).length) {
      lines.push(`Most overdue task: "${context.topOverdueTasks[0].task}" (${context.topOverdueTasks[0].overdueDays}d${context.topOverdueTasks[0].assignee ? `, ${context.topOverdueTasks[0].assignee}` : ""}).`);
    }
  }

  if (!lines.length) return "No data available for the requested scope.";
  return lines.join("\n");
}
