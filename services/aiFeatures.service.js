// services/aiFeatures.service.js
// Phase 3 AI Features:
//   1. Meeting Notes → Tasks extraction
//   2. Predictive deadline risk scoring
//   3. Smart notification suppression
//   4. Natural-language reporting

import db from "../db.js";
import { generateText } from "./llm.js";

// ─── LLM call helper ──────────────────────────────────────────────────────────
async function llm(prompt, maxTokens = 500, json = false) {
  try {
    return await generateText({ prompt, maxTokens, json });
  } catch (err) {
    console.warn("[aiFeatures] LLM error:", err.message);
    return null;
  }
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const start = cleaned.indexOf("[") !== -1 ? cleaned.indexOf("[") : cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("]") !== -1 ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return fallback;
  }
}

// ─── 1. Meeting Notes → Tasks ─────────────────────────────────────────────────

/**
 * Rule-based fallback: parses structured "X will Y" / "X is going to Y" / "Action: Y" patterns.
 * Works without an LLM. Returns same shape as LLM output.
 */
function ruleBasedExtract(notes) {
  const tasks = [];
  const lines = notes.split(/\n+/).map(l => l.trim()).filter(Boolean);

  // Patterns: "[Name] will [action]", "[Name] is going to [action]", "- [Name]: [action]"
  const ACTION_RE = /^([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*)\s+(?:will|is going to|should|must|needs? to)\s+(.+)/i;
  const BULLET_RE = /^[-•*]\s*(?:action[:\s]+)?(.+)/i;
  const GROUP_RE  = /^(?:the\s+)?(?:team|group|everyone|all)\s+(?:will|should|must|needs? to)\s+(.+)/i;

  for (const line of lines) {
    // Check group pattern FIRST so "The group will..." doesn't get parsed as person "The"
    const groupMatch = line.match(GROUP_RE);
    if (groupMatch) {
      tasks.push({
        title:         groupMatch[1].replace(/[.。]+$/, "").slice(0, 120),
        description:   line,
        assignee_hint: null,
        due_date_hint: null,
        priority:      /urgent|tomorrow|kickoff|deadline/i.test(line) ? "high" : "medium",
      });
      continue;
    }

    const actionMatch = line.match(ACTION_RE);
    if (actionMatch) {
      const [, person, action] = actionMatch;
      tasks.push({
        title:         action.replace(/[.。]+$/, "").slice(0, 120),
        description:   line,
        assignee_hint: person.split(" ")[0],
        due_date_hint: null,
        priority:      /urgent|asap|today|immediately|critical/i.test(line) ? "high"
                     : /tomorrow|kickoff|deadline/i.test(line) ? "high" : "medium",
      });
      continue;
    }

    // Plain bullet points that look like action items
    const bulletMatch = line.match(BULLET_RE);
    if (bulletMatch && bulletMatch[1].length > 10) {
      tasks.push({
        title:         bulletMatch[1].replace(/[.。]+$/, "").slice(0, 120),
        description:   "",
        assignee_hint: null,
        due_date_hint: null,
        priority:      "medium",
      });
    }
  }

  return tasks;
}

/**
 * Extract actionable tasks from meeting notes text.
 * Uses LLM when available, falls back to rule-based parsing.
 * Returns an array of task-like objects ready to be created.
 */
export async function extractTasksFromMeetingNotes(notes, { workspaceId, projectId, createdBy }) {
  const prompt = `You are an assistant that extracts actionable tasks from meeting notes.

Meeting notes:
"""
${notes.slice(0, 3000)}
"""

Extract all clear action items and tasks. For each, provide:
- title: short task title (max 80 chars)
- description: optional context (1-2 sentences)
- assignee_hint: person mentioned as responsible (first name or null)
- due_date_hint: relative due date like "next Monday", "end of week", or null
- priority: "low" | "medium" | "high" based on urgency

Return ONLY a JSON array. Example:
[{"title":"...", "description":"...", "assignee_hint":null, "due_date_hint":null, "priority":"medium"}]`;

  const raw = await llm(prompt, 800, true);
  let tasks = parseJson(raw, []);

  // LLM failed or returned nothing — fall back to rule-based extraction
  if (!Array.isArray(tasks) || tasks.length === 0) {
    tasks = ruleBasedExtract(notes);
  }

  if (tasks.length === 0) return [];

  // Resolve assignee hints to user IDs (exclude pending/unlicensed users)
  const members = await db.query(
    "SELECT u.id, u.username FROM users u JOIN workspace_users wu ON wu.user_id = u.id WHERE wu.workspace_id = $1 AND wu.billing_status != 'pending'",
    [workspaceId]
  );

  return tasks.map(t => {
    const hint = (t.assignee_hint || "").toLowerCase();
    const assignee = hint
      ? members.rows.find(m =>
          m.username.toLowerCase().includes(hint) ||
          hint.includes(m.username.toLowerCase().split(" ")[0])
        )
      : null;

    return {
      title:         t.title || "Untitled task",
      description:   t.description || "",
      priority:      ["low", "medium", "high"].includes(t.priority) ? t.priority : "medium",
      assignee_id:   assignee?.id || null,
      assignee_name: assignee?.username || t.assignee_hint || null,
      project_id:    projectId || null,
      due_date_hint: t.due_date_hint || null,
      workspace_id:  workspaceId,
      created_by:    createdBy,
      source:        "meeting_notes",
    };
  });
}

// ─── 2. Predictive Deadline Risk ──────────────────────────────────────────────

/**
 * Score a task's deadline risk using historical data + AI.
 * Returns { riskLevel: 'low'|'medium'|'high'|'critical', riskScore: 0-100, reason, suggestions }
 */
export async function predictDeadlineRisk(taskId, workspaceId) {
  const taskRow = await db.query(
    `SELECT t.*, u.username AS assignee_name,
            (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id AND status != 'done') AS open_subtasks,
            (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) AS total_subtasks,
            (SELECT COUNT(*) FROM comments WHERE task_id = t.id) AS comment_count
     FROM tasks t
     LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspaceId]
  );

  const task = taskRow.rows[0];
  if (!task) return null;

  // Historical: how often does this assignee miss deadlines?
  let lateRate = 0;
  if (task.assigned_to) {
    const hist = await db.query(
      `SELECT COUNT(*) FILTER (WHERE updated_at > due_date AND status = 'done') AS late,
              COUNT(*) FILTER (WHERE due_date IS NOT NULL) AS total
       FROM tasks
       WHERE assigned_to = $1 AND workspace_id = $2 AND status = 'done' AND due_date IS NOT NULL`,
      [task.assigned_to, workspaceId]
    );
    const h = hist.rows[0];
    if (parseInt(h.total) > 0) lateRate = parseInt(h.late) / parseInt(h.total);
  }

  const daysLeft = task.due_date
    ? Math.ceil((new Date(task.due_date) - new Date()) / 86400000)
    : null;

  // Rule-based score
  let score = 0;
  if (daysLeft !== null) {
    if (daysLeft < 0)  score += 50;
    else if (daysLeft <= 1) score += 35;
    else if (daysLeft <= 3) score += 20;
    else if (daysLeft <= 7) score += 10;
  }
  if (lateRate > 0.5) score += 25;
  else if (lateRate > 0.3) score += 15;
  const openRatio = task.total_subtasks > 0 ? task.open_subtasks / task.total_subtasks : 0;
  if (openRatio > 0.7) score += 15;
  if (["in_progress", "todo"].includes(task.status) && daysLeft !== null && daysLeft <= 2) score += 10;
  score = Math.min(100, score);

  const riskLevel = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";

  // AI suggestions for high/critical
  let aiSuggestions = [];
  if (score >= 45) {
    const prompt = `A task "${task.task}" (status: ${task.status}) has ${daysLeft !== null ? `${daysLeft} days left` : "no due date"}, ${task.open_subtasks} open subtasks, and the assignee historically finishes tasks late ${Math.round(lateRate * 100)}% of the time.

Give 2-3 short concrete suggestions to get this task back on track. Return as a JSON array of strings.`;
    const raw = await llm(prompt, 200, true);
    aiSuggestions = parseJson(raw, []);
  }

  return {
    riskLevel,
    riskScore: score,
    daysLeft,
    lateRate: Math.round(lateRate * 100),
    openSubtasks: parseInt(task.open_subtasks),
    suggestions: Array.isArray(aiSuggestions) ? aiSuggestions.slice(0, 3) : [],
  };
}

// ─── 3. Smart Notification Digest ────────────────────────────────────────────

/**
 * Bundle multiple pending notifications into a smart digest.
 * Groups by priority and de-duplicates.
 */
export async function generateSmartDigest(userId, workspaceId) {
  const rows = await db.query(
    `SELECT n.*, t.task AS task_title, p.name AS project_name
     FROM notifications n
     LEFT JOIN tasks t ON t.id = n.task_id
     LEFT JOIN projects p ON p.id = n.project_id
     WHERE n.user_id = $1 AND n.workspace_id = $2
       AND n.is_read = false AND n.created_at > NOW() - INTERVAL '24 hours'
     ORDER BY n.created_at DESC
     LIMIT 30`,
    [userId, workspaceId]
  );

  const notifications = rows.rows;
  if (notifications.length === 0) return { summary: "No new notifications.", items: [] };

  const notifSummary = notifications.slice(0, 15).map(n =>
    `- ${n.type}: ${n.task_title || n.message || "activity"}`
  ).join("\n");

  const prompt = `You have these recent workspace notifications:
${notifSummary}

Write a 2-sentence friendly digest summary highlighting the most important items. Be direct and actionable.`;

  const summary = await llm(prompt, 120) || `You have ${notifications.length} unread notifications.`;

  // Group by type
  const grouped = notifications.reduce((acc, n) => {
    const key = n.type || "general";
    if (!acc[key]) acc[key] = [];
    acc[key].push(n);
    return acc;
  }, {});

  return { summary, items: grouped, total: notifications.length };
}

// ─── 4. Natural-Language Reports ─────────────────────────────────────────────

/**
 * Generate a natural-language report for a workspace.
 * type: 'weekly' | 'sprint' | 'project'
 */
export async function generateNlReport({ workspaceId, type = "weekly", projectId, sprintId }) {
  const isProject = type === "project";
  const since = type === "weekly" ? "7 days" : "30 days";

  // For project reports: no date filter, must have projectId
  if (isProject && !projectId) throw new Error("projectId is required for project reports");

  // Fetch project name for project reports
  let projectName = null;
  if (isProject) {
    const pRow = await db.query("SELECT name FROM projects WHERE id = $1", [projectId]);
    projectName = pRow.rows[0]?.name || "Unknown Project";
  }

  const taskStatsQuery = isProject
    ? db.query(
        `SELECT status, COUNT(*) AS count FROM tasks
         WHERE workspace_id = $1 AND project_id = $2
         GROUP BY status`,
        [workspaceId, projectId]
      )
    : db.query(
        `SELECT status, COUNT(*) AS count FROM tasks
         WHERE workspace_id = $1 AND updated_at > NOW() - INTERVAL '${since}'
         GROUP BY status`,
        [workspaceId]
      );

  const memberStatsQuery = isProject
    ? db.query(
        `SELECT u.username,
                COUNT(*) FILTER (WHERE t.status = 'done') AS completed,
                COUNT(*) AS total
         FROM tasks t
         JOIN users u ON u.id = t.assigned_to
         WHERE t.workspace_id = $1 AND t.project_id = $2
         GROUP BY u.id, u.username
         ORDER BY completed DESC LIMIT 5`,
        [workspaceId, projectId]
      )
    : db.query(
        `SELECT u.username,
                COUNT(*) FILTER (WHERE t.status = 'done') AS completed,
                COUNT(*) AS total
         FROM tasks t
         JOIN users u ON u.id = t.assigned_to
         WHERE t.workspace_id = $1 AND t.updated_at > NOW() - INTERVAL '${since}'
         GROUP BY u.id, u.username
         ORDER BY completed DESC LIMIT 5`,
        [workspaceId]
      );

  const overdueQuery = isProject
    ? db.query(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE workspace_id = $1 AND project_id = $2 AND due_date < NOW() AND status != 'done'`,
        [workspaceId, projectId]
      )
    : db.query(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE workspace_id = $1 AND due_date < NOW() AND status != 'done'`,
        [workspaceId]
      );

  const [taskStats, memberStats, overdueRow] = await Promise.all([taskStatsQuery, memberStatsQuery, overdueQuery]);

  const statusMap = Object.fromEntries(taskStats.rows.map(r => [r.status, parseInt(r.count)]));
  const overdue = parseInt(overdueRow.rows[0]?.count || 0);
  const topMembers = memberStats.rows;

  const scope = isProject ? `project "${projectName}"` : `workspace (last ${since})`;
  const prompt = `You are a project management analyst. Generate a concise ${type} report for ${scope}.

Data:
- Tasks done: ${statusMap.done || 0}
- Tasks in progress: ${statusMap.in_progress || 0}
- Tasks todo: ${statusMap.todo || 0}
- Overdue tasks: ${overdue}
- Top contributors: ${topMembers.map(m => `${m.username} (${m.completed}/${m.total})`).join(", ") || "none"}

Write a professional 3-4 paragraph report covering:
1. Executive summary (1 sentence)
2. Progress highlights
3. Risks & concerns
4. Recommended next steps

Be specific and data-driven.`;

  let report;
  try {
    report = await llm(prompt, 600);
  } catch {}

  if (!report) {
    report = buildDeterministicReport({ type, scope, statusMap, overdue, topMembers });
  }

  return {
    type,
    projectName: projectName || undefined,
    period: isProject ? "all time" : since,
    stats: { ...statusMap, overdue },
    topPerformers: topMembers,
    report,
    generatedAt: new Date().toISOString(),
  };
}

function buildDeterministicReport({ type, scope, statusMap, overdue, topMembers }) {
  const done = parseInt(statusMap.done || 0);
  const inProgress = parseInt(statusMap.in_progress || 0);
  const todo = parseInt(statusMap.todo || 0);
  const total = done + inProgress + todo;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const topLine = topMembers.length > 0
    ? topMembers.map(m => `${m.username} (${m.completed}/${m.total} completed)`).join(", ")
    : "No assignee data available";

  const riskLine = overdue > 0
    ? `${overdue} task${overdue > 1 ? "s are" : " is"} overdue and require immediate attention.`
    : "No overdue tasks — the team is on track.";

  const recommendation = overdue > 0
    ? `Prioritize resolving the ${overdue} overdue item${overdue > 1 ? "s" : ""} before starting new work.`
    : `Continue current momentum and review in-progress tasks for blockers.`;

  return `${type.charAt(0).toUpperCase() + type.slice(1)} Report — ${scope}

Executive Summary: ${total} total task${total !== 1 ? "s" : ""} tracked this period. ${done} completed (${completionRate}% completion rate), ${inProgress} in progress, ${todo} pending.

Progress Highlights: The team completed ${done} task${done !== 1 ? "s" : ""} this period. ${inProgress > 0 ? `${inProgress} task${inProgress !== 1 ? "s are" : " is"} currently in progress.` : "All active tasks have been resolved."} Top contributors: ${topLine}.

Risks & Concerns: ${riskLine}${todo > 0 ? ` ${todo} task${todo !== 1 ? "s" : ""} remain in the backlog.` : ""}

Recommended Next Steps: ${recommendation} Ensure all team members have a balanced workload and that sprint goals remain achievable.`;
}

// ─── 5. AI Task Summarizer ────────────────────────────────────────────────────

/**
 * Generate a concise plain-English summary of a task (for notifications/tooltips).
 */
export async function summarizeTask(taskId, workspaceId) {
  const row = await db.query(
    `SELECT t.task AS title, t.description, t.status, t.priority, t.due_date,
            u.username AS assignee,
            (SELECT COUNT(*) FROM comments WHERE task_id = t.id) AS comments,
            (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id AND status = 'done') AS done_sub,
            (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) AS total_sub
     FROM tasks t
     LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspaceId]
  );

  const task = row.rows[0];
  if (!task) return null;

  const prompt = `Summarize this task in 1-2 sentences for a notification:
Title: ${task.title}
Status: ${task.status}, Priority: ${task.priority}
Assignee: ${task.assignee || "unassigned"}
Due: ${task.due_date ? new Date(task.due_date).toDateString() : "no due date"}
Progress: ${task.done_sub}/${task.total_sub} subtasks done, ${task.comments} comments

Write only the summary sentence.`;

  const summary = await llm(prompt, 80);
  return { summary, task };
}
