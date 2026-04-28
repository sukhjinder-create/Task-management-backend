import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";
import { buildAIContext } from "./ai.context.builder.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeToken(v = "") {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatNames(names = []) {
  if (!Array.isArray(names) || names.length === 0) return "none";
  return names.join(", ");
}

function formatDuration(minutes = 0) {
  const mins = Math.max(0, Number(minutes || 0));
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs <= 0) return `${rem} minute(s)`;
  return `${hrs}h ${rem}m`;
}

function sanitizeForReadableLLM(value) {
  if (Array.isArray(value)) return value.map((v) => sanitizeForReadableLLM(v));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lk = k.toLowerCase();
    if (lk === "id" || lk.endsWith("_id") || lk.startsWith("id_")) continue;
    out[k] = sanitizeForReadableLLM(v);
  }
  return out;
}

// ─── User resolution ─────────────────────────────────────────────────────────

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
    const { rows } = await pool.query(
      `SELECT id, username, email FROM users WHERE workspace_id = $1 AND LOWER(username) = LOWER($2) LIMIT 1`,
      [workspaceId, mentionMatch[1]]
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
    const unameLower = String(u.username || "").toLowerCase();
    const unameNorm = normalizeToken(unameLower);
    let score = 0;
    if (lower.includes(unameLower)) score += 4;
    if (unameNorm && normalizedQ.includes(unameNorm)) score += 4;
    const parts = unameLower.split(/[\s._-]+/).filter((p) => p.length >= 3);
    for (const p of parts) {
      if (lower.includes(p)) score += 1;
    }
    if (score > bestScore) { best = u; bestScore = score; }
  }

  return bestScore >= 4 ? best : null;
}

// ─── Date window parser ───────────────────────────────────────────────────────

function parseDateWindow(question = "") {
  const q = String(question || "").toLowerCase();
  if (/\btoday\b/.test(q)) return { label: "today", from: "CURRENT_DATE", to: "CURRENT_DATE", mode: "sql" };
  if (/yesterday/.test(q)) return { label: "yesterday", from: "CURRENT_DATE - INTERVAL '1 day'", to: "CURRENT_DATE - INTERVAL '1 day'", mode: "sql" };
  if (/last\s+7\s+days|past\s+7\s+days/.test(q)) return { label: "last 7 days", from: "CURRENT_DATE - INTERVAL '6 days'", to: "CURRENT_DATE", mode: "sql" };
  if (/this\s+week/.test(q)) return { label: "this week", from: "date_trunc('week', NOW())::date", to: "CURRENT_DATE", mode: "sql" };
  if (/last\s+week/.test(q)) return { label: "last week", from: "(date_trunc('week', NOW())::date - INTERVAL '7 days')", to: "(date_trunc('week', NOW())::date - INTERVAL '1 day')", mode: "sql" };
  if (/this\s+month/.test(q)) return { label: "this month", from: "date_trunc('month', NOW())::date", to: "CURRENT_DATE", mode: "sql" };
  if (/last\s+month/.test(q)) return { label: "last month", from: "(date_trunc('month', NOW())::date - INTERVAL '1 month')", to: "(date_trunc('month', NOW())::date - INTERVAL '1 day')", mode: "sql" };
  if (/all\s*time|overall|lifetime|ever/.test(q)) return { label: "all time", mode: "all" };
  return { label: "last 30 days", from: "CURRENT_DATE - INTERVAL '29 days'", to: "CURRENT_DATE", mode: "sql" };
}

// ─── Attendance analytics (AWS / lunch counts) ────────────────────────────────

async function fetchUserAttendanceAggregate({ workspaceId, userId, kind, window }) {
  const eventType = kind === "aws" ? "AWS_START" : "LUNCH_START";
  const minutesColumn = kind === "aws" ? "aws_minutes" : "lunch_minutes";

  if (window.mode === "all") {
    const [countRes, durationRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS count FROM attendance_events WHERE workspace_id = $1 AND user_id = $2 AND event_type = $3`,
        [workspaceId, userId, eventType]
      ),
      pool.query(
        `SELECT COALESCE(SUM(${minutesColumn}), 0)::int AS minutes FROM attendance_daily WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId]
      ),
    ]);
    return { count: Number(countRes.rows[0]?.count || 0), minutes: Number(durationRes.rows[0]?.minutes || 0) };
  }

  const [countRes, durationRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM attendance_events WHERE workspace_id = $1 AND user_id = $2 AND event_type = $3 AND started_at::date >= ${window.from} AND started_at::date <= ${window.to}`,
      [workspaceId, userId, eventType]
    ),
    pool.query(
      `SELECT COALESCE(SUM(${minutesColumn}), 0)::int AS minutes FROM attendance_daily WHERE workspace_id = $1 AND user_id = $2 AND date >= ${window.from} AND date <= ${window.to}`,
      [workspaceId, userId]
    ),
  ]);
  return { count: Number(countRes.rows[0]?.count || 0), minutes: Number(durationRes.rows[0]?.minutes || 0) };
}

// ─── Real-time attendance — only deterministic part ───────────────────────────

async function buildAttendanceAnswer({ workspaceId, question, context }) {
  const lower = String(question || "").toLowerCase();
  const live = context?.attendance?.live || {};
  const today = context?.attendance?.todaySignIns || {};
  const liveUsers = live?.users || [];
  const generatedAt = live?.generatedAt ? new Date(live.generatedAt).toISOString() : new Date().toISOString();

  // AWS/lunch analytics (with time range) — always deterministic
  const asksAws = /\baws\b|away\b|away from screen/i.test(lower);
  const asksLunch = /\blunch\b|break/i.test(lower);
  const wantsAnalytics = /(how many times|times|frequency|how much time|duration|for how long)/i.test(lower);
  if ((asksAws || asksLunch) && wantsAnalytics) {
    const kind = asksAws ? "aws" : "lunch";
    const targetUser = await resolveTargetUser(workspaceId, question);
    if (!targetUser) {
      return `Please specify the user name for ${kind.toUpperCase()} analytics (e.g. "How many times did Sarah take ${kind} this month?").`;
    }
    const window = parseDateWindow(question);
    const agg = await fetchUserAttendanceAggregate({ workspaceId, userId: targetUser.id, kind, window });
    const label = kind.toUpperCase();
    const asksDuration = /(how much time|total time|duration|for how long|minutes|hours)/i.test(lower);
    const asksTimes = /(how many times|times|frequency)/i.test(lower);
    if (asksDuration && !asksTimes) return `${label} total time for ${targetUser.username} (${window.label}): ${formatDuration(agg.minutes)}.`;
    if (asksTimes && !asksDuration) return `${label} count for ${targetUser.username} (${window.label}): ${agg.count} time(s).`;
    return `${label} summary for ${targetUser.username} (${window.label}): ${agg.count} time(s), total ${formatDuration(agg.minutes)}.`;
  }

  // Person-specific availability (is parmeet available? / is sukhjinder signed in?)
  const targetUser = await resolveTargetUser(workspaceId, question);
  if (targetUser) {
    const userStatus = liveUsers.find((u) => u.userId === targetUser.id);
    if (userStatus) {
      const statusStr =
        userStatus.status === "aws" ? "away from screen (AWS)" :
        userStatus.status === "lunch" ? "on lunch break" :
        "available (signed in)";
      const since = userStatus.signedInAt
        ? ` — signed in at ${new Date(userStatus.signedInAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
        : "";
      return `${targetUser.username} is currently ${statusStr}${since}.`;
    }
    return `${targetUser.username} is not currently signed in.`;
  }

  // Generic real-time attendance overview
  const available = live?.available || { count: 0, names: [], more: 0 };
  const aws = live?.aws || { count: 0, names: [], more: 0 };
  const lunch = live?.lunch || { count: 0, names: [], more: 0 };
  const totalSignedIn = Number(live?.totalSignedIn || 0);

  const asksSignedInToday = /(signed in|sign.?in|checked in|logged in).*(today)|today.*(signed in|sign.?in)|who has signed in today/i.test(lower);
  const asksSignedIn = /signed in|sign.?in|checked in|logged in|present today/i.test(lower);
  const asksAvailable = /\bavailable\b|online\b|active\b/i.test(lower);

  if (asksSignedInToday) {
    return [
      `Date: ${today.date || new Date().toISOString().slice(0, 10)}.`,
      `Signed in today: ${Number(today.totalSignedInToday || 0)} user(s).`,
      `Names: ${formatNames(today.names)}${today.more > 0 ? ` (+${today.more} more)` : ""}.`,
      `Currently signed in: ${Number(today.currentlySignedIn || 0)} user(s).`,
      `Data timestamp: ${generatedAt}.`,
    ].join("\n");
  }

  if (asksAvailable) {
    return `Available right now: ${available.count} user(s).\nNames: ${formatNames(available.names)}${available.more > 0 ? ` (+${available.more} more)` : ""}.\nData timestamp: ${generatedAt}.`;
  }

  if (asksSignedIn) {
    const liveNames = Array.from(new Set([...(available.names || []), ...(aws.names || []), ...(lunch.names || [])]));
    return `Currently signed in: ${totalSignedIn} user(s).\nNames: ${formatNames(liveNames)}.\nData timestamp: ${generatedAt}.`;
  }

  return `Live attendance: ${totalSignedIn} signed in, ${available.count} available, ${aws.count} on AWS, ${lunch.count} on lunch.\nData timestamp: ${generatedAt}.`;
}

// ─── Deterministic fallback (LLM unavailable) ────────────────────────────────

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
  } else if (scope === "project") {
    const p = context.project || {};
    lines.push(`Project: ${p.name || "Unknown"}`);
    lines.push(`Tasks: ${proj.total || 0} total — ${proj.completed || 0} done, ${proj.inProgress || 0} in progress, ${proj.pending || 0} pending, ${proj.overdueOpen || 0} overdue.`);
  } else {
    lines.push(`Workspace tasks: ${ws.total || 0} total — ${ws.completed || 0} done, ${ws.inProgress || 0} in progress, ${ws.pending || 0} pending, ${ws.overdueOpen || 0} overdue.`);
    if ((context.projectHealth || []).length) {
      const sorted = [...context.projectHealth].sort((a, b) => b.overdueTasks - a.overdueTasks);
      lines.push(`Highest risk project: ${sorted[0].projectName} (${sorted[0].overdueTasks} overdue, ${sorted[0].completionRate}% complete).`);
    }
  }

  if (!lines.length) return "No data available for the requested scope.";
  return lines.join("\n");
}

// ─── Main query entry point ───────────────────────────────────────────────────

export async function runAIIntelligenceQuery({ workspaceId, scope, entityId, question }) {
  try {
    const lower = String(question || "").toLowerCase();

    // Build structured context from DB
    const context = await buildAIContext({ workspaceId, scope, entityId, question });

    // Real-time attendance is always deterministic — LLM can't know live status
    const isAttendanceQuestion =
      /(attendance|signed in|sign.?in|available|availability|aws|away from screen|lunch|online|present|absent|who is|who's|how many people|headcount|check in|clock in)/i.test(lower);

    if (isAttendanceQuestion) {
      return await buildAttendanceAnswer({ workspaceId, question, context });
    }

    // Everything else → LLM with rich context + system role
    const contextForLlm = sanitizeForReadableLLM(context);
    const contextJson = JSON.stringify(contextForLlm, null, 2);

    const today = new Date().toISOString().slice(0, 10);

    const systemMessage = `You are Asystence AI, a workspace intelligence assistant embedded in the Asystence platform.

You have real-time access to this workspace's data: tasks, projects, team members, attendance, activity, goals, and performance metrics.

Rules:
1. Answer ONLY questions about this specific workspace — tasks, projects, team members, attendance, performance, activity, goals, etc.
2. If the question is completely unrelated to the workspace (e.g. general knowledge, weather, jokes, code unrelated to workspace), respond ONLY with: "I'm configured to answer questions about your workspace only. Ask me about tasks, projects, team members, attendance, or workspace activity."
3. Answer naturally and conversationally — like an intelligent assistant who knows this team deeply.
4. Use real names, specific numbers, and concrete details from the data provided.
5. Never expose raw IDs or UUIDs.
6. Keep answers concise (2-5 sentences or a short bullet list). Max 200 words.
7. If the question cannot be fully answered from available data, say what you know and what's missing.
8. Today's date is ${today}.`;

    const userMessage = `Question: "${question}"\n\nWorkspace Data (scope: ${scope}):\n${contextJson}`;

    console.log(`[AI Intelligence] scope=${scope} entity=${entityId || "N/A"} question="${question}" context_chars=${contextJson.length}`);

    if (systemMessage.length + userMessage.length > 50000) {
      console.warn("[AI Intelligence] Prompt too large, using fallback");
      return buildFallbackAnswer({ context, scope });
    }

    try {
      const answer = await generateText({
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
        maxTokens: 350,
      });
      if (answer) return String(answer).trim();
    } catch (llmErr) {
      console.warn("[AI Intelligence] LLM unavailable, using deterministic fallback:", llmErr.message);
    }

    return buildFallbackAnswer({ context, scope });
  } catch (error) {
    console.error("AI Intelligence Query Failed:", error.message);
    throw error;
  }
}
