import pool from "../db.js";
import { generateText } from "../intelligence/llm/llmClient.js";
import { buildAIContext } from "./ai.context.builder.js";

const OUT_OF_SCOPE_MARKER = "[OUT_OF_SCOPE]";
const OUT_OF_SCOPE_MESSAGE =
  "I'm only configured to answer questions about your workspace — tasks, projects, team members, attendance, goals, and activity. Please ask me something related to your workspace.";

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

function buildFallbackAnswer({ context, scope }) {
  const ws = context.workspaceSummary || {};
  const proj = context.projectSummary || {};
  const task = context.taskFacts || {};

  if (scope === "task") {
    const lines = [
      `Task: "${context.task?.task || "Untitled"}"`,
      `Status: ${task.status || "unknown"} | Priority: ${task.priority || "unset"} | Assignee: ${task.assignee || "unassigned"}`,
    ];
    if (task.isOverdue) lines.push(`Overdue by ${task.overdueDays || "?"} day(s).`);
    if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
    return lines.join("\n");
  }

  if (scope === "project") {
    return [
      `Project tasks: ${proj.total || 0} total — ${proj.completed || 0} done, ${proj.inProgress || 0} in progress, ${proj.pending || 0} pending, ${proj.overdueOpen || 0} overdue.`,
    ].join("\n");
  }

  const lines = [
    `Workspace tasks: ${ws.total || 0} total — ${ws.completed || 0} done, ${ws.inProgress || 0} in progress, ${ws.pending || 0} pending, ${ws.overdueOpen || 0} overdue.`,
  ];
  if ((context.projectHealth || []).length) {
    const top = [...context.projectHealth].sort((a, b) => b.overdueTasks - a.overdueTasks)[0];
    lines.push(`Highest risk project: ${top.projectName} (${top.overdueTasks} overdue, ${top.completionRate}% complete).`);
  }
  return lines.join("\n");
}

export async function runAIIntelligenceQuery({ workspaceId, scope, entityId, question }) {
  try {
    const context = await buildAIContext({ workspaceId, scope, entityId, question });
    const contextForLlm = sanitizeForReadableLLM(context);
    const contextJson = JSON.stringify(contextForLlm, null, 2);
    const today = new Date().toISOString().slice(0, 10);

    const systemMessage = `You are Asystence AI, an intelligent workspace assistant embedded in the Asystence platform.

You have access to real-time workspace data including: tasks, projects, team members (with task stats), live attendance (who is signed in right now and their status), recent activity, goals, and performance metrics.

IMPORTANT RULES:

1. SCOPE DETECTION — This is your most critical rule:
   - If the question is about THIS workspace (tasks, projects, members, attendance, performance, goals, reviews, leaves, activity, reports, etc.) → answer it.
   - If the question has NOTHING to do with this workspace (politics, general knowledge, weather, entertainment, writing essays, telling jokes, coding help unrelated to workspace, etc.) → respond with ONLY the exact text: ${OUT_OF_SCOPE_MARKER}
   - When in doubt, assume it's workspace-related and try to answer.

2. ANSWERING STYLE:
   - Be conversational and natural, like an intelligent team assistant.
   - Use real names, numbers, and specific details from the data.
   - Do NOT expose raw IDs or UUIDs.
   - Keep responses concise: 2–5 sentences or a short bullet list. Max 200 words.
   - If the answer isn't fully available in the data, say what you know and what's missing.

3. ATTENDANCE DATA:
   - The "attendance.live.users" array contains ONLY users currently signed in, with their status: "available", "aws" (away from screen), or "lunch".
   - If a person is NOT in that array, they are NOT currently signed in.
   - Use this to answer "is X available?", "who is online?", "where is X?" type questions.

4. Today's date is ${today}. Use this for overdue calculations and date-relative questions.`;

    const userMessage = `Question: "${question}"\n\nWorkspace Data (scope: ${scope}):\n${contextJson}`;

    console.log(`[AI Intelligence] scope=${scope} entity=${entityId || "N/A"} question="${question}" context_chars=${contextJson.length}`);

    if (systemMessage.length + userMessage.length > 50000) {
      console.warn("[AI Intelligence] Prompt too large, using deterministic fallback");
      return buildFallbackAnswer({ context, scope });
    }

    try {
      const raw = await generateText({
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
        maxTokens: 400,
      });

      const answer = String(raw || "").trim();
      if (answer.includes(OUT_OF_SCOPE_MARKER)) {
        return OUT_OF_SCOPE_MESSAGE;
      }
      if (answer) return answer;
    } catch (llmErr) {
      console.warn("[AI Intelligence] LLM unavailable, using deterministic fallback:", llmErr.message);
    }

    return buildFallbackAnswer({ context, scope });
  } catch (error) {
    console.error("AI Intelligence Query Failed:", error.message);
    throw error;
  }
}
