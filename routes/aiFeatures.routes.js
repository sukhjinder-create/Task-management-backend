// routes/aiFeatures.routes.js
// Phase 3 AI Feature endpoints
import express from "express";
import db from "../db.js";
import { generateText } from "../services/llm.js";
import {
  extractTasksFromMeetingNotes,
  predictDeadlineRisk,
  generateSmartDigest,
  generateNlReport,
  summarizeTask,
} from "../services/aiFeatures.service.js";
import { createTask } from "../services/task.service.js";
import { logAudit } from "../services/audit.service.js";

const router = express.Router();

// ─── Meeting Notes → Tasks ────────────────────────────────────────────────────

/**
 * POST /ai-features/meeting-notes
 * body: { notes: string, projectId?: string, autoCreate?: boolean }
 * Returns extracted tasks. If autoCreate=true, inserts them into DB.
 */
router.post("/meeting-notes", async (req, res) => {
  try {
    const { notes, projectId, autoCreate = false, tasks: providedTasks } = req.body;
    if (!notes || notes.trim().length < 20) {
      return res.status(400).json({ error: "Please provide meeting notes (at least 20 characters)" });
    }

    if (autoCreate && !projectId) {
      return res.status(400).json({ error: "A project must be selected before creating tasks" });
    }

    // If tasks were already extracted by the frontend, use them directly (no re-extraction)
    const tasks = Array.isArray(providedTasks) && providedTasks.length > 0
      ? providedTasks
      : await extractTasksFromMeetingNotes(notes, {
          workspaceId: req.workspaceId,
          projectId: projectId || null,
          createdBy: req.user.id,
        });

    let created = [];
    if (autoCreate && tasks.length > 0) {
      for (const t of tasks) {
        const newTask = await createTask({
          task:        t.title,
          project_id:  projectId,
          description: t.description || "",
          priority:    t.priority || "medium",
          assigned_to: t.assignee_id || null,
          added_by:    req.user.id,
          workspaceId: req.workspaceId,
        });
        created.push({ id: newTask.id, title: newTask.task, display_id: newTask.display_id });
      }

      await logAudit({
        workspaceId: req.workspaceId, userId: req.user.id,
        action: "ai.meeting_notes.tasks_created",
        metadata: { count: created.length },
      });
    }

    res.json({ tasks, created: autoCreate ? created : [], total: tasks.length });
  } catch (err) {
    console.error("Meeting notes error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Predictive Deadline Risk ─────────────────────────────────────────────────

/**
 * GET /ai-features/tasks/:taskId/risk
 */
router.get("/tasks/:taskId/risk", async (req, res) => {
  try {
    const result = await predictDeadlineRisk(req.params.taskId, req.workspaceId);
    if (!result) return res.status(404).json({ error: "Task not found" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /ai-features/risks
 * Returns risk scores for all tasks with due dates in the workspace.
 */
router.get("/risks", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id FROM tasks
       WHERE workspace_id = $1 AND due_date IS NOT NULL AND status != 'done'
       ORDER BY due_date ASC LIMIT 50`,
      [req.workspaceId]
    );

    const risks = await Promise.all(
      rows.rows.map(r => predictDeadlineRisk(r.id, req.workspaceId))
    );

    res.json(risks.filter(Boolean).sort((a, b) => b.riskScore - a.riskScore));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Smart Notification Digest ────────────────────────────────────────────────

/**
 * GET /ai-features/digest
 */
router.get("/digest", async (req, res) => {
  try {
    const digest = await generateSmartDigest(req.user.id, req.workspaceId);
    res.json(digest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NL Reports ───────────────────────────────────────────────────────────────

/**
 * POST /ai-features/report
 * body: { type: 'weekly'|'sprint'|'project', projectId?, sprintId? }
 */
router.post("/report", async (req, res) => {
  const { type = "weekly", projectId, sprintId } = req.body;

  if (req.user.role === "manager") {
    // Managers may only generate project reports for their assigned projects
    if (type !== "project") {
      return res.status(403).json({ error: "Managers can only generate project reports" });
    }
    if (!projectId) {
      return res.status(400).json({ error: "projectId is required" });
    }
    const { rows } = await db.query(
      `SELECT projects FROM users WHERE id = $1`,
      [req.user.id]
    );
    const assignedProjects = rows[0]?.projects || [];
    if (!assignedProjects.includes(projectId)) {
      return res.status(403).json({ error: "Not assigned to this project" });
    }
  } else if (!["admin", "owner"].includes(req.user.role)) {
    return res.status(403).json({ error: "Admin required for workspace reports" });
  }

  try {
    const result = await generateNlReport({
      workspaceId: req.workspaceId,
      type,
      projectId: projectId || null,
      sprintId: sprintId || null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Task Summarizer ──────────────────────────────────────────────────────────

/**
 * GET /ai-features/tasks/:taskId/summary
 */
router.get("/tasks/:taskId/summary", async (req, res) => {
  try {
    const result = await summarizeTask(req.params.taskId, req.workspaceId);
    if (!result) return res.status(404).json({ error: "Task not found" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI-assisted task creation from plain text ─────────────────────────────────

/**
 * POST /ai-features/parse-task
 * body: { text: "assign new login page design to John, high priority, due Friday" }
 */
router.post("/parse-task", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    const members = await db.query(
      "SELECT u.id, u.username FROM users u JOIN workspace_users wu ON wu.user_id = u.id WHERE wu.workspace_id = $1 AND wu.billing_status != 'pending'",
      [req.workspaceId]
    );
    const projects = await db.query(
      "SELECT id, name FROM projects WHERE workspace_id = $1 LIMIT 20",
      [req.workspaceId]
    );

    const prompt = `Parse this task description and extract structured data:
"${text}"

Team members: ${members.rows.map(m => m.username).join(", ") || "none"}
Projects: ${projects.rows.map(p => p.name).join(", ") || "none"}

Return ONLY JSON with:
{
  "title": "task title",
  "priority": "low|medium|high",
  "assignee_name": "matched team member name or null",
  "project_name": "matched project name or null",
  "due_date_hint": "relative date or null",
  "labels": ["label1"]
}`;

    let raw = null;
    try {
      raw = await generateText({ prompt, maxTokens: 200 });
    } catch {
      // LLM unavailable — return a basic parse without AI enhancement
      return res.json({
        title: text,
        priority: "medium",
        assignee_id: null,
        assignee_name: null,
        project_id: null,
        project_name: null,
        due_date_hint: null,
        labels: [],
      });
    }

    let parsed = {};
    try {
      const cleaned = (raw || "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch { parsed = { title: text }; }

    // Resolve references
    const assignee = parsed.assignee_name
      ? members.rows.find(m => m.username.toLowerCase().includes(parsed.assignee_name.toLowerCase()))
      : null;
    const project = parsed.project_name
      ? projects.rows.find(p => p.name.toLowerCase().includes(parsed.project_name.toLowerCase()))
      : null;

    res.json({
      title:       parsed.title || text,
      priority:    ["low","medium","high"].includes(parsed.priority) ? parsed.priority : "medium",
      assignee_id: assignee?.id || null,
      assignee_name: assignee?.username || null,
      project_id:  project?.id || null,
      project_name: project?.name || null,
      due_date_hint: parsed.due_date_hint || null,
      labels:      Array.isArray(parsed.labels) ? parsed.labels : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
