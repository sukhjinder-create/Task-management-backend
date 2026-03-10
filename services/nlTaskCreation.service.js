// services/nlTaskCreation.service.js
import { generateText } from "../intelligence/llm/llmClient.js";
import { createTask } from "./task.service.js";
import pool from "../db.js";
import { createSubtask } from "./task.service.js";

/**
 * 🎙️ NATURAL LANGUAGE TASK CREATION
 *
 * Parses natural language commands and creates tasks automatically
 * Example: "Create 3 tasks for login feature, assign to John, due Friday"
 */

/**
 * Parse natural language and extract task creation intent
 */
export async function parseNaturalLanguageCommand({
  command,
  workspaceId,
  userId
}) {
  console.log("Parsing NL command:", command);

  // Step 1: Get context (available projects, users)
  const context = await getWorkspaceContext(workspaceId);
  const commandInEnglish = await normalizeCommandToEnglish(command);

  // Pre-extract signals from raw command to help LLM
  const detectedPriority = extractPriorityFromKeywords(commandInEnglish);
  const detectedDate = extractRelativeDate(commandInEnglish.toLowerCase());
  const detectedTags = extractTags(commandInEnglish);
  const today = new Date().toISOString().split("T")[0];

  // Step 2: Use AI to extract structured data
  const prompt = `You are a task creation assistant. Extract task details from natural language.

WORKSPACE CONTEXT:
Projects: ${context.projects.map(p => `"${p.name}" (id: ${p.id})`).join(", ") || "none"}
Users: ${context.users.map(u => `"${u.username}" (id: ${u.id})`).join(", ") || "none"}

USER COMMAND: "${commandInEnglish}"

Pre-detected signals (use these as hints):
- Priority: ${detectedPriority || "not detected, default medium"}
- Due date: ${detectedDate || "not detected, use null"}
- Tags: ${detectedTags.length ? detectedTags.join(", ") : "none"}
- Today: ${today}

Return ONLY valid JSON (no markdown, no explanation):
{"tasks":[{"task":"title","description":"description","project_id":"uuid or null","assigned_to":"uuid or null","priority":"high|medium|low","due_date":"YYYY-MM-DD or null","tags":["tag1"],"subtasks":["subtask 1","subtask 2"]}],"summary":"brief summary"}

RULES:
- If command has a bulleted/numbered list (-, *, 1., 2., etc), each list item = one separate task
- If "X tasks" mentioned, create X task objects with distinct titles
- Match project names to available projects; if none matched, use project_id: null
- Match person names/usernames to available users; if none matched, use assigned_to: null
- Use pre-detected priority if provided, else infer from context
- Use pre-detected due date if provided, else infer from text ("Friday" → next Friday, etc.)
- Add 2-4 realistic subtasks per task
- All output text must be in English
- Keep task titles concise (under 80 chars)
- Return ONLY the JSON object`;

  try {
    const response = await generateText({ prompt, maxTokens: 2000 });

    let jsonStr = response.trim()
      .replace(/^```json\n?/i, "").replace(/^```\n?/, "").replace(/```\n?$/, "").trim();

    // Extract JSON object if there's surrounding text
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    if (start !== -1 && end !== -1) jsonStr = jsonStr.slice(start, end + 1);

    const parsed = JSON.parse(jsonStr);

    return {
      success: true,
      tasks: parsed.tasks || [],
      summary: parsed.summary || "Tasks extracted from command",
      context,
      commandInEnglish,
    };
  } catch (err) {
    console.error("Failed to parse NL command, using fallback parser:", err.message);
    const fallback = fallbackParseCommand(commandInEnglish || command, context);
    return {
      success: true,
      tasks: fallback.tasks,
      summary: fallback.summary,
      context,
      commandInEnglish: commandInEnglish || command,
    };
  }
}

/**
 * Parse-only (dry run) — returns what would be created without saving anything
 */
export async function parseOnlyFromNL({ command, workspaceId, userId }) {
  const parsed = await parseNaturalLanguageCommand({ command, workspaceId, userId });
  return {
    tasks: parsed.tasks,
    summary: parsed.summary,
    commandInEnglish: parsed.commandInEnglish,
    context: {
      projects: parsed.context.projects.map(p => ({ id: p.id, name: p.name })),
      users: parsed.context.users.map(u => ({ id: u.id, username: u.username, email: u.email })),
    },
  };
}

/**
 * Get workspace context (exported for the /nl/context route)
 */
export async function getNLContext(workspaceId) {
  return getWorkspaceContext(workspaceId);
}

/**
 * Create tasks from parsed natural language
 */
export async function createTasksFromNL({
  command,
  workspaceId,
  userId,
  projectId = null,
  includeSubtasks = true,
  autoAssignByWorkload = true,
  autoSetDependencies = true,
}) {
  // Parse the command
  const parsed = await parseNaturalLanguageCommand({
    command,
    workspaceId,
    userId,
  });

  if (!parsed.tasks || parsed.tasks.length === 0) {
    throw new Error("No tasks found in command");
  }

  // If caller provided a project, lock all tasks to that project.
  if (projectId) {
    parsed.tasks = (parsed.tasks || []).map((t) => ({
      ...t,
      project_id: projectId,
    }));
  }

  parsed.tasks = applyExplicitAssignmentFromCommand(
    `${command}\n${parsed.commandInEnglish || ""}`,
    parsed.tasks || [],
    parsed.context.users || []
  );

  // Prepare workload balancing map for automatic assignment.
  const workloadMap = autoAssignByWorkload
    ? await getWorkloadMap(workspaceId, parsed.context.users || [])
    : new Map();

  // Validate and create tasks
  const createdTasks = [];
  const errors = [];
  const dependencyLinks = [];
  let previousTaskTitle = null;

  for (let i = 0; i < parsed.tasks.length; i++) {
    const taskData = parsed.tasks[i];

    try {
      // Validate required fields
      if (!taskData.task || taskData.task.trim().length < 3) {
        errors.push({
          index: i,
          error: "Task title too short or missing",
        });
        continue;
      }

      // If no project specified, try to find a default project
      let projectId = taskData.project_id;
      if (!projectId) {
        const defaultProject = parsed.context.projects[0];
        if (defaultProject) {
          projectId = defaultProject.id;
        } else {
          errors.push({
            index: i,
            task: taskData.task,
            error: "No project available. Create a project first.",
          });
          continue;
        }
      }

      // Workload-aware assignment if request did not specify assignee.
      let assignedTo = taskData.assigned_to || null;
      if (!assignedTo && autoAssignByWorkload) {
        assignedTo = pickLeastLoadedUser(workloadMap);
      }

      const normalizedDueDate =
        taskData.due_date || suggestDueDate(i, parsed.tasks.length);
      const normalizedPriority = normalizePriority(taskData.priority);

      // Automatically append lightweight dependency notes in description.
      const baseDescription = (taskData.description || "").trim();
      const dependencyNote =
        autoSetDependencies && previousTaskTitle
          ? `Depends on: ${previousTaskTitle}`
          : "";
      const mergedDescription = [baseDescription, dependencyNote]
        .filter(Boolean)
        .join("\n\n");

      // Create the task
      const created = await createTask({
        task: taskData.task,
        description: mergedDescription,
        project_id: projectId,
        assigned_to: assignedTo,
        priority: normalizedPriority,
        due_date: normalizedDueDate,
        status: "pending",
        added_by: userId,
        workspaceId,
      });

      // Break into subtasks when available.
      if (includeSubtasks) {
        const subtasks = normalizeSubtasks(taskData.subtasks);
        for (const title of subtasks) {
          try {
            await createSubtask({
              task_id: created.id,
              title,
              assigned_to: assignedTo,
              added_by: userId,
              priority: normalizedPriority,
            });
          } catch (subErr) {
            errors.push({
              index: i,
              task: taskData.task,
              error: `Subtask creation failed: ${subErr.message}`,
            });
          }
        }
      }

      if (assignedTo && autoAssignByWorkload) {
        const prev = workloadMap.get(assignedTo) || 0;
        workloadMap.set(assignedTo, prev + 1);
      }

      if (autoSetDependencies && previousTaskTitle) {
        dependencyLinks.push({
          task: created.task,
          dependsOn: previousTaskTitle,
        });
      }
      previousTaskTitle = created.task;

      createdTasks.push(created);
    } catch (err) {
      errors.push({
        index: i,
        task: taskData.task,
        error: err.message,
      });
    }
  }

  return {
    success: createdTasks.length > 0,
    created: createdTasks,
    errors: errors.length > 0 ? errors : null,
    summary: `Created ${createdTasks.length} of ${parsed.tasks.length} tasks`,
    originalSummary: parsed.summary,
    dependencies: dependencyLinks,
  };
}

/**
 * Get workspace context for AI
 */
async function getWorkspaceContext(workspaceId) {
  // Get available projects
  const { rows: projects } = await pool.query(`
    SELECT id, name, project_code
    FROM projects
    WHERE workspace_id = $1
    ORDER BY created_at DESC
    LIMIT 20
  `, [workspaceId]);

  // Get available users
  const { rows: users } = await pool.query(`
    SELECT id, username, email, role
    FROM users
    WHERE workspace_id = $1
      AND role IN ('user', 'manager', 'admin')
    ORDER BY username ASC
    LIMIT 50
  `, [workspaceId]);

  return { projects, users };
}

/**
 * Suggest completions for partial commands
 */
export async function suggestNLCompletions({
  partialCommand,
  workspaceId,
}) {
  const context = await getWorkspaceContext(workspaceId);

  const suggestions = [];

  // Simple keyword-based suggestions
  const lower = partialCommand.toLowerCase();

  if (lower.includes("create") || lower.includes("add") || lower.includes("new")) {
    suggestions.push({
      text: "Create task for [feature name], assign to [person], due [date]",
      example: true,
    });
    suggestions.push({
      text: "Create 5 tasks for login redesign, high priority, due Friday",
      example: true,
    });
  }

  // Project suggestions
  if (lower.includes("project") || lower.includes("for")) {
    context.projects.slice(0, 5).forEach(p => {
      suggestions.push({
        text: `for ${p.name}`,
        type: "project",
        id: p.id,
      });
    });
  }

  // User suggestions
  if (lower.includes("assign") || lower.includes("to")) {
    context.users.slice(0, 5).forEach(u => {
      suggestions.push({
        text: `assign to ${u.username}`,
        type: "user",
        id: u.id,
      });
    });
  }

  return suggestions;
}

function normalizePriority(priority) {
  const p = String(priority || "medium").toLowerCase();
  if (p === "high" || p === "medium" || p === "low") return p;
  return "medium";
}

function suggestDueDate(index, total) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const spacing = total > 3 ? 1 : 2;
  base.setDate(base.getDate() + (index + 1) * spacing);
  return base.toISOString().slice(0, 10);
}

function normalizeSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map((s) => String(s || "").trim())
    .filter((s) => s.length >= 3)
    .slice(0, 5);
}

/**
 * Extract priority signal from urgency keywords
 */
function extractPriorityFromKeywords(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(urgent|critical|blocker|asap|immediately|emergency|p0|p1|hotfix|showstopper)\b/.test(lower)) return "high";
  if (/\b(low priority|minor|nice.?to.?have|when possible|someday|p3|p4|backlog)\b/.test(lower)) return "low";
  return null;
}

/**
 * Extract tags from #hashtags or known tech keywords
 */
function extractTags(text) {
  const tags = [];
  const hashTags = String(text || "").match(/#([a-zA-Z][a-zA-Z0-9_-]+)/g);
  if (hashTags) tags.push(...hashTags.map(t => t.slice(1).toLowerCase()));

  const keywords = [
    "frontend", "backend", "api", "ui", "ux", "database", "db",
    "bug", "feature", "hotfix", "security", "performance",
    "testing", "qa", "devops", "infra", "mobile", "auth",
  ];
  const lower = String(text || "").toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw) && !tags.includes(kw)) tags.push(kw);
  }
  return tags.slice(0, 5);
}

function pickLeastLoadedUser(workloadMap) {
  if (!workloadMap || workloadMap.size === 0) return null;
  let selectedUserId = null;
  let selectedCount = Number.POSITIVE_INFINITY;
  for (const [userId, count] of workloadMap.entries()) {
    if (count < selectedCount) {
      selectedUserId = userId;
      selectedCount = count;
    }
  }
  return selectedUserId;
}

async function getWorkloadMap(workspaceId, users) {
  const userIds = (users || []).map((u) => u.id).filter(Boolean);
  const result = new Map();
  userIds.forEach((id) => result.set(id, 0));

  if (userIds.length === 0) return result;

  const { rows } = await pool.query(
    `
    SELECT assigned_to, COUNT(*)::int AS open_count
    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = ANY($2::uuid[])
      AND status IN ('pending', 'in-progress')
    GROUP BY assigned_to
    `,
    [workspaceId, userIds]
  );

  for (const row of rows) {
    result.set(row.assigned_to, Number(row.open_count) || 0);
  }

  return result;
}

function fallbackParseCommand(command, context) {
  const text = String(command || "").trim();
  const lower = text.toLowerCase();

  // Check for bulleted/numbered list items first
  const listItems = text.match(/^[\s]*(?:[-*•]|\d+[.):])\s+(.+)$/gm);
  if (listItems && listItems.length > 1) {
    const assignedTo = matchUserId(text, context.users || []);
    const matchedProject = matchProjectId(text, context.projects || []);
    const priority = extractPriorityFromKeywords(text) || "medium";
    const dueDate = extractRelativeDate(lower);
    const tasks = listItems.map((item, i) => {
      const title = item.replace(/^[\s]*(?:[-*•]|\d+[.):])\s+/, "").trim();
      return {
        task: title,
        description: `Auto-generated from command`,
        project_id: matchedProject,
        assigned_to: assignedTo,
        priority,
        due_date: dueDate,
        subtasks: buildDefaultSubtasks(title, i),
      };
    });
    return { tasks, summary: `Generated ${tasks.length} task(s) from list` };
  }

  const countMatch = lower.match(/(\d+)\s+tasks?/);
  const requestedCount = Math.max(
    1,
    Math.min(10, Number(countMatch?.[1] || 1))
  );

  const priority = extractPriorityFromKeywords(text) || (
    lower.includes("high priority") ? "high" :
    lower.includes("low priority") ? "low" : "medium"
  );

  const dueDate = extractRelativeDate(lower);
  const assignedTo = matchUserId(text, context.users || []);
  const matchedProject = matchProjectId(text, context.projects || []);
  const focus = extractFocusTopic(text);

  const tasks = [];
  for (let i = 0; i < requestedCount; i++) {
    const title = buildTaskTitle(focus, i, requestedCount);
    tasks.push({
      task: title,
      description: `Auto-generated from command: "${text}"`,
      project_id: matchedProject,
      assigned_to: assignedTo,
      priority,
      due_date: dueDate,
      subtasks: buildDefaultSubtasks(focus, i),
    });
  }

  return {
    tasks,
    summary: `Generated ${tasks.length} task(s) from natural language command`,
  };
}

function extractFocusTopic(text) {
  const m = text.match(/for\s+(.+?)(?:,|assign|due|$)/i);
  return (m?.[1] || "requested work").trim();
}

function buildTaskTitle(focus, index, total) {
  if (total === 1) return `Implement ${focus}`;
  const phases = [
    "Planning",
    "UI implementation",
    "Validation",
    "Testing",
    "Release prep",
    "Review",
  ];
  const phase = phases[index] || `Part ${index + 1}`;
  return `${phase}: ${focus}`;
}

function buildDefaultSubtasks(focus, index) {
  return [
    `Define scope for ${focus}`,
    `Implement core changes for step ${index + 1}`,
    `Test and verify acceptance criteria`,
  ];
}

function matchUserId(text, users) {
  const lowerText = text.toLowerCase();

  // 1) Direct username/email mention anywhere in command.
  for (const u of users || []) {
    const username = String(u.username || "").trim().toLowerCase();
    const email = String(u.email || "").trim().toLowerCase();
    if (username && lowerText.includes(username)) return u.id;
    if (email && lowerText.includes(email)) return u.id;
  }

  // 2) English phrase fallback.
  const match = lowerText.match(/assign(?:\s+\w+)?\s+to\s+([a-z0-9._ -]+)/i);
  if (!match) return null;
  const wanted = match[1].trim();
  const found = users.find((u) =>
    String(u.username || "").toLowerCase().includes(wanted) ||
    String(u.email || "").toLowerCase().includes(wanted)
  );
  return found?.id || null;
}

function matchProjectId(text, projects) {
  const lower = text.toLowerCase();
  const found = projects.find((p) =>
    lower.includes(String(p.name || "").toLowerCase())
  );
  return found?.id || null;
}

function extractRelativeDate(lower) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const addDays = (d, n) => {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r.toISOString().slice(0, 10);
  };

  // today / ASAP / urgent / immediately
  if (/\b(today|asap|urgent|immediately|now)\b/.test(lower)) return addDays(today, 0);

  // tomorrow
  if (/\btomorrow\b/.test(lower)) return addDays(today, 1);

  // end of week / this week / by friday
  if (/\b(end of week|this week|by friday|eow)\b/.test(lower)) {
    const toFri = ((5 - today.getDay()) + 7) % 7 || 7;
    return addDays(today, toFri);
  }

  // next week
  if (/\bnext week\b/.test(lower)) return addDays(today, 7);

  // end of month / eom
  if (/\b(end of month|eom)\b/.test(lower)) {
    return new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);
  }

  // next month
  if (/\bnext month\b/.test(lower)) {
    const d = new Date(today);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  }

  // end of sprint / next sprint (~2 weeks)
  if (/\b(sprint|end of sprint|next sprint)\b/.test(lower)) return addDays(today, 14);

  // in X days
  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) return addDays(today, parseInt(inDays[1], 10));

  // in X weeks
  const inWeeks = lower.match(/\bin\s+(\d+)\s+weeks?\b/);
  if (inWeeks) return addDays(today, parseInt(inWeeks[1], 10) * 7);

  // named weekday (next Monday, Friday, etc.)
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const matchedDay = weekdays.find((d) => lower.includes(d));
  if (matchedDay) {
    const target = weekdays.indexOf(matchedDay);
    let delta = target - today.getDay();
    if (delta <= 0) delta += 7;
    return addDays(today, delta);
  }

  return null;
}

function applyExplicitAssignmentFromCommand(command, tasks, users) {
  const assigneeId = matchUserId(String(command || ""), users || []);
  if (!assigneeId) return tasks;

  return (tasks || []).map((task) => {
    if (task.assigned_to) return task;
    return { ...task, assigned_to: assigneeId };
  });
}

async function normalizeCommandToEnglish(command) {
  const raw = String(command || "").trim();
  if (!raw) return "";

  const prompt = `You are a strict translator for task management commands.
Translate the following user command to clear English.
Do not add or remove meaning.
Preserve assignee names, project names, priorities, quantities, and dates.
Return ONLY the translated English sentence (plain text, no JSON, no markdown).

USER COMMAND:
${raw}`;

  try {
    const response = await generateText({ prompt });
    let out = String(response || "").trim();

    if (out.startsWith("```")) {
      out = out.replace(/```[a-z]*\n?/gi, "").replace(/```\n?/g, "").trim();
    }

    // Be resilient if model still returns JSON.
    if (out.startsWith("{") && out.endsWith("}")) {
      try {
        const parsed = JSON.parse(out);
        const maybe = String(
          parsed.englishCommand || parsed.translation || parsed.text || ""
        ).trim();
        if (maybe) return maybe;
      } catch {
        // fall through to plain text
      }
    }

    return out || raw;
  } catch {
    return raw;
  }
}
