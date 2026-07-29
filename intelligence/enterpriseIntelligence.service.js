/**
 * Enterprise Intelligence Service
 * Four AI-powered strategic features:
 *   1. Pre-Project Profitability Oracle
 *   2. Resignation Radar
 *   3. Ghost Work Detection
 *   4. Organizational Truth Map
 *
 * All analysis is grounded in real DB data — no fake numbers.
 * LLM adds contextual interpretation on top of quantitative signals.
 */

import pool from "../db.js";
import { generateText } from "../services/llm.js";

/**
 * LLM responses occasionally drift from the requested schema: a field asked for
 * as a string comes back as a nested object, or a prompt placeholder such as
 * "high|medium|low" is echoed back verbatim. Everything returned from these
 * endpoints is rendered directly by the UI, so each insight is flattened to
 * primitives here — at the boundary — rather than trusting the model's shape.
 *
 * All original fields are preserved; only their types are made safe.
 */
function asPlainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asPlainText).filter(Boolean).join(" · ");
  if (typeof value === "object") {
    const preferred =
      asPlainText(value.description) || asPlainText(value.detail) ||
      asPlainText(value.text) || asPlainText(value.message) ||
      asPlainText(value.summary) || asPlainText(value.value);
    if (preferred) return preferred;
    const strings = Object.values(value).filter((v) => typeof v === "string" && v.trim());
    return strings.length ? strings.join(" · ") : "";
  }
  return String(value);
}

const INSIGHT_TEXT_FIELDS = ["title", "detail", "description", "action", "username", "summary", "message", "reason"];
const INSIGHT_ENUM_FIELDS = ["impact", "priority", "urgency", "framing"];

export function normalizeInsights(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const out = {};
      // keep every field the model returned, but never leak a non-primitive
      for (const [k, v] of Object.entries(raw)) {
        out[k] = v === null || typeof v !== "object" ? v : asPlainText(v);
      }
      for (const k of INSIGHT_TEXT_FIELDS) {
        if (out[k] !== undefined) out[k] = asPlainText(out[k]);
      }
      // an un-substituted prompt placeholder ("high|medium|low") is not a value
      for (const k of INSIGHT_ENUM_FIELDS) {
        if (typeof out[k] === "string" && out[k].includes("|")) delete out[k];
      }
      if (!out.detail && out.description) out.detail = out.description;
      return out.title || out.detail || out.action ? out : null;
    })
    .filter(Boolean);
}


// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: Pre-Project Profitability Oracle
//
// Active projects  → burn rate vs backlog growth (is the team keeping up?)
// Completed projects → task growth % + delay rate as historical calibration
//
// "Scope creep" as a fixed-window metric is meaningless on active projects —
// a client grooming their backlog IS expected work, not scope creep.
// The real risk signal is: are you completing faster than you're adding?
// ─────────────────────────────────────────────────────────────────────────────
export async function getProfitabilityOracle(workspaceId) {
  const w4ago = new Date(Date.now() - 28 * 86_400_000).toISOString(); // 4 weeks ago
  const w8ago = new Date(Date.now() - 56 * 86_400_000).toISOString(); // 8 weeks ago

  // 1. Base project metrics
  const { rows: projectRows } = await pool.query(
    `SELECT
        p.id,
        p.name,
        p.created_at,
        COUNT(t.id)                                                              AS total_tasks,
        COUNT(t.id) FILTER (WHERE t.status = 'completed')                       AS completed_tasks,
        COUNT(t.id) FILTER (WHERE t.status != 'completed')                      AS open_tasks,
        COUNT(t.id) FILTER (WHERE t.due_date IS NOT NULL
                                AND t.due_date < NOW()
                                AND t.status != 'completed')                     AS overdue_tasks,
        COUNT(t.id) FILTER (WHERE t.due_date IS NOT NULL)                       AS tasks_with_due,
        COUNT(DISTINCT t.assigned_to)                                            AS team_size,
        MIN(t.created_at)                                                        AS first_task_at,
        MAX(t.updated_at)                                                        AS last_activity_at,
        -- Velocity last 4 weeks: tasks completed
        COUNT(t.id) FILTER (WHERE t.status = 'completed'
                                AND t.updated_at >= $2)                          AS completed_last4w,
        -- Backlog additions last 4 weeks: tasks created
        COUNT(t.id) FILTER (WHERE t.created_at >= $2)                           AS added_last4w,
        -- Previous 4 weeks (for trend comparison)
        COUNT(t.id) FILTER (WHERE t.status = 'completed'
                                AND t.updated_at >= $3
                                AND t.updated_at < $2)                           AS completed_prev4w,
        COUNT(t.id) FILTER (WHERE t.created_at >= $3
                                AND t.created_at < $2)                           AS added_prev4w,
        -- First 14 days task count (initial committed scope)
        COUNT(t.id) FILTER (WHERE t.created_at <= p.created_at + INTERVAL '14 days') AS initial_scope
     FROM projects p
     JOIN tasks t ON t.project_id = p.id AND t.workspace_id = $1
     WHERE p.workspace_id = $1
     GROUP BY p.id, p.name, p.created_at
     HAVING COUNT(t.id) > 0
     ORDER BY p.created_at DESC
     LIMIT 20`,
    [workspaceId, w4ago, w8ago]
  );

  // 2. Per-project analysis
  const now = Date.now();

  const projects = projectRows.map((p) => {
    const totalTasks      = parseInt(p.total_tasks)       || 0;
    const completedTasks  = parseInt(p.completed_tasks)   || 0;
    const openTasks       = parseInt(p.open_tasks)        || 0;
    const overdueTasks    = parseInt(p.overdue_tasks)     || 0;
    const tasksWithDue    = parseInt(p.tasks_with_due)    || 0;
    const teamSize        = parseInt(p.team_size)         || 1;
    const initialScope    = parseInt(p.initial_scope)     || 0;
    const completedL4w    = parseInt(p.completed_last4w)  || 0;
    const addedL4w        = parseInt(p.added_last4w)      || 0;
    const completedP4w    = parseInt(p.completed_prev4w)  || 0;

    const completionRate  = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const delayRate       = tasksWithDue > 0 ? Math.round((overdueTasks / tasksWithDue) * 100) : 0;

    // Days since last activity
    const daysSinceActivity = p.last_activity_at
      ? Math.floor((now - new Date(p.last_activity_at)) / 86_400_000)
      : 999;

    // A project is "active" if it has open tasks AND had activity in last 30 days
    const isActive = openTasks > 0 && daysSinceActivity <= 30;

    // ── ACTIVE project metrics ──────────────────────────────────────────────
    // Burn rate = completions per week (last 4 weeks / 4)
    const burnRatePerWeek   = Math.round((completedL4w / 4) * 10) / 10;
    // Growth rate = new tickets per week (last 4 weeks / 4)
    const growthRatePerWeek = Math.round((addedL4w / 4) * 10) / 10;
    // Net velocity: positive = burning down, negative = accumulating backlog
    const netVelocity       = Math.round((burnRatePerWeek - growthRatePerWeek) * 10) / 10;
    // Projected weeks to clear current backlog at current burn rate
    const projectedWeeks    = burnRatePerWeek > 0
      ? Math.ceil(openTasks / burnRatePerWeek)
      : null;
    // Velocity trend: is burn rate improving vs prior 4 weeks?
    const velocityTrend     = completedP4w > 0
      ? Math.round(((completedL4w - completedP4w) / completedP4w) * 100)
      : 0;

    // ── COMPLETED project metrics ───────────────────────────────────────────
    // Task growth: how much did the project grow from initial scope to final count
    // Only meaningful once the project is done — not on active ones
    const taskGrowthPct = !isActive && initialScope > 0
      ? Math.round(((totalTasks - initialScope) / initialScope) * 100)
      : null;

    const durationDays = p.first_task_at && p.last_activity_at && !isActive
      ? Math.round((new Date(p.last_activity_at) - new Date(p.first_task_at)) / 86_400_000)
      : null;

    // ── Risk score ──────────────────────────────────────────────────────────
    let riskScore = 0;
    const riskSignals = [];

    if (isActive) {
      // Active project risks
      if (netVelocity < 0) {
        // Backlog growing faster than burning → significant risk
        const severity = Math.abs(netVelocity);
        riskScore += Math.min(Math.round(severity * 5), 35);
        riskSignals.push(`Backlog growing ${Math.abs(netVelocity)}/wk faster than completions`);
      }
      if (projectedWeeks !== null && projectedWeeks > 12) {
        riskScore += 20;
        riskSignals.push(`${projectedWeeks} weeks to clear at current pace`);
      }
      if (delayRate >= 30) {
        riskScore += Math.min(Math.round(delayRate * 0.4), 25);
        riskSignals.push(`${delayRate}% of dated tasks are overdue`);
      }
      if (velocityTrend < -20) {
        riskScore += 10;
        riskSignals.push(`Team velocity down ${Math.abs(velocityTrend)}% vs last month`);
      }
      if (teamSize > 5) { riskScore += 5; }
    } else {
      // Completed project risks (historical calibration)
      if (taskGrowthPct !== null && taskGrowthPct > 50) {
        riskScore += Math.min(Math.round(taskGrowthPct * 0.3), 25);
        riskSignals.push(`Task count grew ${taskGrowthPct}% from initial scope`);
      }
      if (delayRate >= 30) {
        riskScore += Math.min(Math.round(delayRate * 0.4), 25);
        riskSignals.push(`${delayRate}% delay rate at completion`);
      }
      riskScore += Math.round((100 - completionRate) * 0.3);
      if (teamSize > 5) { riskScore += 5; }
    }

    const riskLevel = riskScore >= 60 ? "high" : riskScore >= 35 ? "medium" : "low";

    // Profit score: for active = based on velocity health; for completed = completion vs delays
    let profitScore;
    if (isActive) {
      // Healthy = burning fast, low delays, positive velocity trend
      const velocityHealth = burnRatePerWeek > 0
        ? Math.min(100, Math.round((burnRatePerWeek / Math.max(1, growthRatePerWeek)) * 50))
        : 0;
      profitScore = Math.max(0, Math.min(100, Math.round(velocityHealth - delayRate * 0.3)));
    } else {
      const growthPenalty = taskGrowthPct !== null ? Math.min(Math.round(taskGrowthPct * 0.3), 40) : 0;
      profitScore = Math.max(0, Math.min(100, Math.round(completionRate - delayRate * 0.3 - growthPenalty)));
    }

    return {
      projectId:        p.id,
      projectName:      p.name,
      isActive,
      totalTasks,
      completedTasks,
      openTasks,
      completionRate,
      delayRate,
      teamSize,
      durationDays,
      riskScore:        Math.min(100, Math.round(riskScore)),
      riskLevel,
      riskSignals,
      profitScore,
      // Active-only fields
      burnRatePerWeek:   isActive ? burnRatePerWeek  : null,
      growthRatePerWeek: isActive ? growthRatePerWeek : null,
      netVelocity:       isActive ? netVelocity       : null,
      projectedWeeks:    isActive ? projectedWeeks    : null,
      velocityTrend:     isActive ? velocityTrend     : null,
      // Completed-only fields
      taskGrowthPct:     !isActive ? taskGrowthPct    : null,
      initialScope:      !isActive ? initialScope     : null,
    };
  });

  // 3. Workspace calibration from completed projects only
  const completed = projects.filter((p) => !p.isActive);
  const calibration = {
    avgDelayRate:           completed.length ? Math.round(completed.reduce((s, p) => s + p.delayRate, 0) / completed.length) : 0,
    avgCompletionRate:      completed.length ? Math.round(completed.reduce((s, p) => s + p.completionRate, 0) / completed.length) : 0,
    avgDurationDays:        completed.filter((p) => p.durationDays).length
      ? Math.round(completed.filter((p) => p.durationDays).reduce((s, p) => s + p.durationDays, 0) / completed.filter((p) => p.durationDays).length)
      : 0,
    avgTeamSize:            projects.length ? Math.round(projects.reduce((s, p) => s + p.teamSize, 0) / projects.length) : 0,
    avgBurnRatePerWeek:     projects.filter((p) => p.isActive && p.burnRatePerWeek > 0).length
      ? Math.round(projects.filter((p) => p.isActive).reduce((s, p) => s + (p.burnRatePerWeek || 0), 0) / Math.max(1, projects.filter((p) => p.isActive).length) * 10) / 10
      : 0,
  };

  // 4. LLM strategic insight
  let aiInsights = null;
  try {
    const highRisk   = projects.filter((p) => p.riskLevel === "high").slice(0, 3);
    const activeList = projects.filter((p) => p.isActive).slice(0, 3);

    const prompt = `You are a project profitability analyst for a software team.
Workspace overview: ${projects.length} projects (${projects.filter(p => p.isActive).length} active, ${completed.length} completed).
Avg completion rate on finished projects: ${calibration.avgCompletionRate}%. Avg delay rate: ${calibration.avgDelayRate}%.
${activeList.length > 0 ? `Active projects: ${activeList.map(p => `${p.projectName} — burn ${p.burnRatePerWeek}/wk, growth ${p.growthRatePerWeek}/wk, ${p.openTasks} open tasks${p.projectedWeeks ? `, ~${p.projectedWeeks}wk to complete` : ""}`).join("; ")}` : ""}
${highRisk.length > 0 ? `High-risk: ${highRisk.map(p => `${p.projectName} (${p.riskSignals.join(", ")})`).join("; ")}` : ""}

Give 3 specific, actionable insights to improve delivery and profitability. Reference actual numbers. Be direct.
Respond ONLY with valid JSON: {"insights":[{"title":"...","detail":"...","impact":"high|medium|low"}]}`;

    const raw = await generateText({ prompt, maxTokens: 600, json: true });
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) aiInsights = normalizeInsights(JSON.parse(m[0]).insights);
  } catch (_) { /* LLM unavailable — degrade gracefully */ }

  return { calibration, projects, aiInsights };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: Resignation Radar
// 60-day early-warning using real attendance + task + collaboration signals
// ─────────────────────────────────────────────────────────────────────────────
export async function getResignationRadar(workspaceId) {
  const { rows: users } = await pool.query(
    `SELECT u.id, u.username, u.email, u.avatar_url, wu.role
     FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE wu.billing_status != 'pending'`,
    [workspaceId]
  );
  if (!users.length) return { users: [], highRisk: [], aiInsights: null, summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 } };

  const userIds      = users.map((u) => u.id);
  const now          = new Date();
  const d30          = new Date(now - 30 * 86_400_000).toISOString();
  const d60          = new Date(now - 60 * 86_400_000).toISOString();

  // Task completions: last 30d vs prior 30d
  const { rows: taskRows } = await pool.query(
    `SELECT
        assigned_to                                                          AS user_id,
        COUNT(*) FILTER (WHERE updated_at >= $2 AND status = 'completed')  AS recent_comp,
        COUNT(*) FILTER (WHERE updated_at >= $3 AND updated_at < $2
                            AND status = 'completed')                       AS prev_comp
     FROM tasks
     WHERE workspace_id = $1 AND assigned_to = ANY($4)
     GROUP BY assigned_to`,
    [workspaceId, d30, d60, userIds]
  );

  // Attendance: avg signed-in minutes last 30d vs prior 30d
  const { rows: attRows } = await pool.query(
    `SELECT
        user_id,
        AVG(signed_in_minutes) FILTER (WHERE date >= $2::date)                    AS recent_att,
        AVG(signed_in_minutes) FILTER (WHERE date >= $3::date AND date < $2::date) AS prev_att,
        COUNT(*) FILTER (WHERE date >= $2::date AND signed_in_minutes > 0)        AS recent_days
     FROM attendance_daily
     WHERE workspace_id = $1 AND user_id = ANY($4)
     GROUP BY user_id`,
    [workspaceId, d30, d60, userIds]
  );

  // Comment activity: last 30d vs prior 30d
  const { rows: cmtRows } = await pool.query(
    `SELECT
        c.added_by                                                  AS user_id,
        COUNT(*) FILTER (WHERE c.created_at >= $2)                 AS recent_cmt,
        COUNT(*) FILTER (WHERE c.created_at >= $3
                            AND c.created_at < $2)                  AS prev_cmt
     FROM comments c
     JOIN tasks t ON t.id = c.task_id AND t.workspace_id = $1
     WHERE c.added_by = ANY($4)
     GROUP BY c.added_by`,
    [workspaceId, d30, d60, userIds]
  );

  // Last activity from task logs
  const { rows: actRows } = await pool.query(
    `SELECT actor_id AS user_id, MAX(created_at) AS last_action_at
     FROM task_activity_logs
     WHERE workspace_id = $1 AND actor_id = ANY($2)
     GROUP BY actor_id`,
    [workspaceId, userIds]
  );

  const taskMap = Object.fromEntries(taskRows.map((r) => [r.user_id, r]));
  const attMap  = Object.fromEntries(attRows.map((r) => [r.user_id, r]));
  const cmtMap  = Object.fromEntries(cmtRows.map((r) => [r.user_id, r]));
  const actMap  = Object.fromEntries(actRows.map((r) => [r.user_id, r]));

  const analyzed = users.map((user) => {
    const t   = taskMap[user.id] || {};
    const a   = attMap[user.id]  || {};
    const c   = cmtMap[user.id]  || {};
    const act = actMap[user.id]  || {};

    const recentComp = parseInt(t.recent_comp) || 0;
    const prevComp   = parseInt(t.prev_comp)   || 0;
    const recentAtt  = parseFloat(a.recent_att) || 0;
    const prevAtt    = parseFloat(a.prev_att)   || 0;
    const recentCmt  = parseInt(c.recent_cmt)  || 0;
    const prevCmt    = parseInt(c.prev_cmt)    || 0;

    const lastActionAt = act.last_action_at ? new Date(act.last_action_at) : null;
    const daysSilent   = lastActionAt ? Math.floor((now - lastActionAt) / 86_400_000) : 999;

    const taskDrop = prevComp > 0 ? Math.max(0, Math.round(((prevComp - recentComp) / prevComp) * 100)) : 0;
    const attDrop  = prevAtt  > 0 ? Math.max(0, Math.round(((prevAtt  - recentAtt)  / prevAtt)  * 100)) : 0;
    const cmtDrop  = prevCmt  > 0 ? Math.max(0, Math.round(((prevCmt  - recentCmt)  / prevCmt)  * 100)) : 0;

    let riskScore = 0;
    const signals = [];

    if (attDrop >= 30)  { riskScore += 30; signals.push(`Attendance down ${attDrop}%`); }
    else if (attDrop >= 15) { riskScore += 15; signals.push(`Attendance slightly down ${attDrop}%`); }

    if (taskDrop >= 40) { riskScore += 25; signals.push(`Task output down ${taskDrop}%`); }
    else if (taskDrop >= 20) { riskScore += 12; signals.push(`Task output down ${taskDrop}%`); }

    if (cmtDrop >= 50)  { riskScore += 20; signals.push(`Collaboration down ${cmtDrop}%`); }
    else if (cmtDrop >= 25) { riskScore += 10; signals.push(`Collaboration down ${cmtDrop}%`); }

    if (daysSilent >= 14) { riskScore += 15; signals.push(`${daysSilent} days of inactivity`); }
    else if (daysSilent >= 7)  { riskScore += 7;  signals.push(`${daysSilent} days quiet`); }

    // New users with no baseline → cap risk
    if (prevComp === 0 && prevAtt === 0 && prevCmt === 0) riskScore = Math.min(riskScore, 15);

    const riskLevel = riskScore >= 55 ? "critical" : riskScore >= 35 ? "high" : riskScore >= 20 ? "medium" : "low";

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatar_url,
      role: user.role,
      riskScore: Math.min(100, riskScore),
      riskLevel,
      signals,
      metrics: {
        recentTaskCompletions: recentComp,
        prevTaskCompletions: prevComp,
        taskDrop,
        recentAttendanceMinutes: Math.round(recentAtt),
        prevAttendanceMinutes: Math.round(prevAtt),
        attendanceDrop: attDrop,
        recentComments: recentCmt,
        prevComments: prevCmt,
        commentDrop: cmtDrop,
        daysSilent,
      },
    };
  });

  analyzed.sort((a, b) => b.riskScore - a.riskScore);
  const highRisk = analyzed.filter((u) => u.riskLevel === "critical" || u.riskLevel === "high");

  let aiInsights = null;
  if (highRisk.length > 0) {
    try {
      const summary = highRisk.slice(0, 5).map((u) =>
        `${u.username} (${u.riskLevel}, score ${u.riskScore}): ${u.signals.join(", ")}`
      ).join("\n");

      const prompt = `You are an HR analytics expert. These employees show 60-day resignation risk signals:\n${summary}\n\nFor each person listed, suggest ONE specific retention action based on their signals. Be concrete and empathetic — not generic. Distinguish disengagement from workload burnout.
Respond ONLY with valid JSON: {"recommendations":[{"username":"...","action":"...","urgency":"immediate|this_week|this_month"}]}`;
      const raw = await generateText({ prompt, maxTokens: 600, json: true });
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) aiInsights = normalizeInsights(JSON.parse(m[0]).recommendations);
    } catch (_) { /* degrade gracefully */ }
  }

  return {
    users: analyzed,
    highRisk,
    aiInsights,
    summary: {
      total: analyzed.length,
      critical: analyzed.filter((u) => u.riskLevel === "critical").length,
      high:     analyzed.filter((u) => u.riskLevel === "high").length,
      medium:   analyzed.filter((u) => u.riskLevel === "medium").length,
      low:      analyzed.filter((u) => u.riskLevel === "low").length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 3: Ghost Work Detection
// Detect attendance–productivity mismatch, activity bursts, quality failures
// ─────────────────────────────────────────────────────────────────────────────
export async function getGhostWorkDetection(workspaceId) {
  const { rows: users } = await pool.query(
    `SELECT u.id, u.username, u.email, u.avatar_url, wu.role
     FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE wu.billing_status != 'pending'`,
    [workspaceId]
  );
  if (!users.length) return { users: [], flagged: [], aiInsights: null, summary: { total: 0, critical: 0, high: 0, medium: 0, clean: 0 }, workspaceBenchmarks: {} };

  const userIds = users.map((u) => u.id);
  const d30     = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Attendance last 30d
  const { rows: attRows } = await pool.query(
    `SELECT
        user_id,
        SUM(signed_in_minutes)  AS total_signed_in,
        AVG(signed_in_minutes)  AS avg_signed_in,
        COUNT(*) FILTER (WHERE signed_in_minutes > 0) AS active_days
     FROM attendance_daily
     WHERE workspace_id = $1 AND user_id = ANY($2) AND date >= $3::date
     GROUP BY user_id`,
    [workspaceId, userIds, d30]
  );

  // Task output last 30d
  const { rows: taskRows } = await pool.query(
    `SELECT
        assigned_to                                                              AS user_id,
        COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= $2)       AS completions,
        COUNT(*)                                                                  AS total_assigned
     FROM tasks
     WHERE workspace_id = $1 AND assigned_to = ANY($3)
     GROUP BY assigned_to`,
    [workspaceId, d30, userIds]
  );

  // Hourly burst detection from task_activity_logs
  const { rows: burstRows } = await pool.query(
    `SELECT
        actor_id               AS user_id,
        COUNT(*)               AS total_actions,
        MAX(hourly_count)      AS max_hourly_burst
     FROM (
        SELECT actor_id,
               DATE_TRUNC('hour', created_at) AS h,
               COUNT(*)                        AS hourly_count
        FROM task_activity_logs
        WHERE workspace_id = $1 AND actor_id = ANY($2) AND created_at >= $3
        GROUP BY actor_id, h
     ) sub
     GROUP BY actor_id`,
    [workspaceId, userIds, d30]
  );

  // Reopened tasks: tasks the user completed that were later moved back out of completed
  const { rows: reopenRows } = await pool.query(
    `SELECT
        t.assigned_to          AS user_id,
        COUNT(DISTINCT t.id)   AS reopened_count
     FROM tasks t
     WHERE t.workspace_id = $1
       AND t.assigned_to = ANY($2)
       AND t.status != 'completed'
       AND EXISTS (
          SELECT 1 FROM task_activity_logs tal
          WHERE tal.task_id = t.id
            AND tal.action_type = 'STATUS_CHANGED'
            AND tal.new_value->>'status' = 'completed'
            AND tal.created_at >= $3
       )
     GROUP BY t.assigned_to`,
    [workspaceId, userIds, d30]
  );

  const attMap    = Object.fromEntries(attRows.map((r) => [r.user_id, r]));
  const taskMap   = Object.fromEntries(taskRows.map((r) => [r.user_id, r]));
  const burstMap  = Object.fromEntries(burstRows.map((r) => [r.user_id, r]));
  const reopenMap = Object.fromEntries(reopenRows.map((r) => [r.user_id, r]));

  const avgAtt  = attRows.length  ? attRows.reduce((s, r) => s + parseFloat(r.avg_signed_in || 0), 0) / attRows.length : 0;
  const avgComp = taskRows.length ? taskRows.reduce((s, r) => s + parseInt(r.completions || 0), 0)   / taskRows.length : 0;

  const analyzed = users.map((user) => {
    const a = attMap[user.id]    || {};
    const t = taskMap[user.id]   || {};
    const b = burstMap[user.id]  || {};
    const r = reopenMap[user.id] || {};

    const avgSignedIn    = parseFloat(a.avg_signed_in) || 0;
    const totalSignedIn  = parseFloat(a.total_signed_in) || 0;
    const completions    = parseInt(t.completions)    || 0;
    const totalAssigned  = parseInt(t.total_assigned) || 0;
    const maxBurst       = parseInt(b.max_hourly_burst) || 0;
    const reopened       = parseInt(r.reopened_count)  || 0;

    const flags = [];
    let ghostScore = 0;

    // Signal 1: High attendance + low output vs workspace average
    if (avgSignedIn > avgAtt * 0.8 && completions < avgComp * 0.3 && avgComp > 2) {
      ghostScore += 35;
      flags.push({ type: "attendance_output_mismatch", label: "High presence, low output", detail: `${Math.round(avgSignedIn)} min/day avg but only ${completions} tasks completed vs workspace avg of ${Math.round(avgComp)}`, severity: "high" });
    }

    // Signal 2: Suspicious activity burst (rubber-stamping)
    if (maxBurst > 15) {
      ghostScore += 30;
      flags.push({ type: "velocity_burst", label: "Suspicious activity burst", detail: `${maxBurst} task actions in a single hour — possible bulk status updates`, severity: "high" });
    } else if (maxBurst > 8) {
      ghostScore += 15;
      flags.push({ type: "velocity_burst", label: "High activity burst", detail: `${maxBurst} task actions in one hour`, severity: "medium" });
    }

    // Signal 3: High reopened task rate (quality / completeness failure)
    if (completions > 0 && reopened / completions > 0.3) {
      ghostScore += 25;
      flags.push({ type: "quality_issue", label: "High task rejection rate", detail: `${reopened}/${completions} completed tasks were reopened (${Math.round((reopened / completions) * 100)}%)`, severity: "high" });
    } else if (completions > 0 && reopened / completions > 0.15) {
      ghostScore += 10;
      flags.push({ type: "quality_issue", label: "Elevated rejection rate", detail: `${reopened}/${completions} tasks reopened`, severity: "medium" });
    }

    // Signal 4: Clocking time with zero task assignments
    if (avgSignedIn > 120 && totalAssigned === 0) {
      ghostScore += 20;
      flags.push({ type: "no_assignments", label: "Present but unassigned", detail: "Regularly clocking attendance with no task assignments in the system", severity: "medium" });
    }

    const riskLevel = ghostScore >= 55 ? "critical" : ghostScore >= 35 ? "high" : ghostScore >= 15 ? "medium" : "clean";

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatar_url,
      role: user.role,
      ghostScore: Math.min(100, ghostScore),
      riskLevel,
      flags,
      metrics: {
        avgAttendanceMinutes: Math.round(avgSignedIn),
        taskCompletions: completions,
        totalAssigned,
        maxHourlyBurst: maxBurst,
        reopenedTasks: reopened,
      },
    };
  });

  analyzed.sort((a, b) => b.ghostScore - a.ghostScore);
  const flagged = analyzed.filter((u) => u.riskLevel !== "clean");

  let aiInsights = null;
  if (flagged.length > 0) {
    try {
      const summary = flagged.slice(0, 5).map((u) =>
        `${u.username}: ${u.flags.map((f) => f.label).join(", ")} (score ${u.ghostScore})`
      ).join("\n");
      const prompt = `You are a workplace integrity analyst. These employees show potential productivity inflation signals:\n${summary}\n\nFor each, suggest ONE specific, fair next step. Distinguish process issues from potential misconduct. Be professional.
Respond ONLY with valid JSON: {"recommendations":[{"username":"...","action":"...","framing":"process_issue|needs_investigation|monitor"}]}`;
      const raw = await generateText({ prompt, maxTokens: 500, json: true });
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) aiInsights = normalizeInsights(JSON.parse(m[0]).recommendations);
    } catch (_) { /* degrade gracefully */ }
  }

  return {
    users: analyzed,
    flagged,
    aiInsights,
    summary: {
      total:    analyzed.length,
      critical: analyzed.filter((u) => u.riskLevel === "critical").length,
      high:     analyzed.filter((u) => u.riskLevel === "high").length,
      medium:   analyzed.filter((u) => u.riskLevel === "medium").length,
      clean:    analyzed.filter((u) => u.riskLevel === "clean").length,
    },
    workspaceBenchmarks: {
      avgAttendanceMinutes:  Math.round(avgAtt),
      avgMonthlyCompletions: Math.round(avgComp),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 4: Organizational Truth Map
// Value multipliers, knowledge bottlenecks, hidden load, archetype mapping
// ─────────────────────────────────────────────────────────────────────────────
export async function getOrgTruthMap(workspaceId) {
  const { rows: users } = await pool.query(
    `SELECT u.id, u.username, u.email, u.avatar_url, wu.role
     FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE wu.billing_status != 'pending'`,
    [workspaceId]
  );
  if (!users.length) return { users: [], archetypeBreakdown: {}, keyRisks: {}, aiInsights: null };

  const userIds = users.map((u) => u.id);
  const d90     = new Date(Date.now() - 90 * 86_400_000).toISOString();

  // Task output + cross-project breadth (last 90d)
  const { rows: outputRows } = await pool.query(
    `SELECT
        assigned_to                                                          AS user_id,
        COUNT(*) FILTER (WHERE status = 'completed')                        AS completions,
        COUNT(DISTINCT project_id)                                           AS projects_touched,
        COUNT(*)                                                             AS total_assigned,
        COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= $2)   AS recent_completions
     FROM tasks
     WHERE workspace_id = $1 AND assigned_to = ANY($3)
     GROUP BY assigned_to`,
    [workspaceId, d90, userIds]
  );

  // Collaboration: comments left on OTHER people's tasks (last 90d)
  const { rows: collabRows } = await pool.query(
    `SELECT
        c.added_by                          AS user_id,
        COUNT(*)                            AS comments_on_others,
        COUNT(DISTINCT t.assigned_to)       AS people_helped
     FROM comments c
     JOIN tasks t ON t.id = c.task_id AND t.workspace_id = $1
     WHERE c.added_by = ANY($2)
       AND (t.assigned_to IS NULL OR t.assigned_to != c.added_by)
       AND c.created_at >= $3
     GROUP BY c.added_by`,
    [workspaceId, userIds, d90]
  );

  // Bottleneck signal: how many distinct people comment on THIS person's tasks
  const { rows: bottleneckRows } = await pool.query(
    `SELECT
        t.assigned_to                       AS user_id,
        COUNT(DISTINCT c.added_by)          AS commenters_on_their_tasks,
        COUNT(c.id)                         AS total_comments_received
     FROM tasks t
     JOIN comments c ON c.task_id = t.id
     WHERE t.workspace_id = $1
       AND t.assigned_to = ANY($2)
       AND (c.added_by IS NULL OR c.added_by != t.assigned_to)
       AND c.created_at >= $3
     GROUP BY t.assigned_to`,
    [workspaceId, userIds, d90]
  );

  // Hidden load: tasks not in any sprint (backlog, invisible work)
  const { rows: hiddenRows } = await pool.query(
    `SELECT
        assigned_to                                                          AS user_id,
        COUNT(*) FILTER (WHERE sprint_id IS NULL AND status != 'completed') AS backlog_tasks,
        COUNT(*)                                                             AS total_tasks
     FROM tasks
     WHERE workspace_id = $1 AND assigned_to = ANY($2)
     GROUP BY assigned_to`,
    [workspaceId, userIds]
  );

  // Leadership signal: how many tasks did this user create for others (last 90d)
  const { rows: leaderRows } = await pool.query(
    `SELECT
        actor_id            AS user_id,
        COUNT(*)            AS tasks_created
     FROM task_activity_logs
     WHERE workspace_id = $1 AND actor_id = ANY($2)
       AND action_type = 'TASK_CREATED'
       AND created_at >= $3
     GROUP BY actor_id`,
    [workspaceId, userIds, d90]
  );

  const outputMap     = Object.fromEntries(outputRows.map((r) => [r.user_id, r]));
  const collabMap     = Object.fromEntries(collabRows.map((r) => [r.user_id, r]));
  const bottleneckMap = Object.fromEntries(bottleneckRows.map((r) => [r.user_id, r]));
  const hiddenMap     = Object.fromEntries(hiddenRows.map((r) => [r.user_id, r]));
  const leaderMap     = Object.fromEntries(leaderRows.map((r) => [r.user_id, r]));

  // Normalisation denominators
  const maxComp       = Math.max(1, ...outputRows.map((r) => parseInt(r.completions) || 0));
  const maxCollab     = Math.max(1, ...collabRows.map((r) => parseInt(r.comments_on_others) || 0));
  const maxBottleneck = Math.max(1, ...bottleneckRows.map((r) => parseInt(r.commenters_on_their_tasks) || 0));
  const maxProjects   = Math.max(1, ...outputRows.map((r) => parseInt(r.projects_touched) || 0));

  const analyzed = users.map((user) => {
    const o  = outputMap[user.id]     || {};
    const co = collabMap[user.id]     || {};
    const b  = bottleneckMap[user.id] || {};
    const h  = hiddenMap[user.id]     || {};
    const l  = leaderMap[user.id]     || {};

    const completions        = parseInt(o.completions)              || 0;
    const projectsTouched    = parseInt(o.projects_touched)         || 0;
    const commentsOnOthers   = parseInt(co.comments_on_others)      || 0;
    const peopleHelped       = parseInt(co.people_helped)           || 0;
    const commentersOnThem   = parseInt(b.commenters_on_their_tasks) || 0;
    const backlogTasks       = parseInt(h.backlog_tasks)            || 0;
    const totalTasks         = parseInt(h.total_tasks)              || 0;
    const tasksCreated       = parseInt(l.tasks_created)            || 0;

    const outputScore      = Math.round((completions        / maxComp)       * 100);
    const collabScore      = Math.round((commentsOnOthers   / maxCollab)     * 100);
    const bottleneckScore  = Math.round((commentersOnThem   / maxBottleneck) * 100);
    const breadthScore     = Math.round((projectsTouched    / maxProjects)   * 100);
    const leaderScore      = Math.min(100, tasksCreated * 10);

    const valueScore = Math.round(
      outputScore    * 0.35 +
      collabScore    * 0.25 +
      breadthScore   * 0.20 +
      leaderScore    * 0.10 +
      bottleneckScore * 0.10
    );

    const hiddenLoadPct = totalTasks > 0 ? Math.round((backlogTasks / totalTasks) * 100) : 0;

    // Archetype assignment (mutually exclusive, priority-ordered)
    let archetype;
    if (valueScore >= 70 && bottleneckScore >= 50)                      archetype = "cornerstone";
    else if (valueScore >= 70 && collabScore  >= 60)                    archetype = "multiplier";
    else if (valueScore >= 55 && hiddenLoadPct >= 40)                   archetype = "invisible_contributor";
    else if (bottleneckScore >= 70 && outputScore < 40)                 archetype = "bottleneck";
    else if (outputScore     >= 70 && collabScore < 20)                 archetype = "solo_performer";
    else if (leaderScore     >= 60 && outputScore < 30)                 archetype = "orchestrator";
    else                                                                  archetype = "contributor";

    const archetypeLabels = {
      cornerstone:           "Cornerstone",
      multiplier:            "Force Multiplier",
      invisible_contributor: "Invisible Contributor",
      bottleneck:            "Bottleneck",
      solo_performer:        "Solo Performer",
      orchestrator:          "Orchestrator",
      contributor:           "Contributor",
    };

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatar_url,
      role: user.role,
      valueScore,
      archetype,
      archetypeLabel: archetypeLabels[archetype],
      scores: { output: outputScore, collaboration: collabScore, breadth: breadthScore, bottleneck: bottleneckScore, leadership: leaderScore },
      metrics: { tasksCompleted: completions, projectsTouched, commentsOnOthers, peopleHelped, commentersOnThem, backlogTasks, totalTasks, hiddenLoadPct, tasksCreated },
    };
  });

  analyzed.sort((a, b) => b.valueScore - a.valueScore);

  const cornerstones  = analyzed.filter((u) => u.archetype === "cornerstone");
  const invisible     = analyzed.filter((u) => u.archetype === "invisible_contributor");
  const bottlenecks   = analyzed.filter((u) => u.archetype === "bottleneck");
  const multipliers   = analyzed.filter((u) => u.archetype === "multiplier");

  let aiInsights = null;
  try {
    const topStr  = analyzed.slice(0, 5).map((u) => `${u.username}: ${u.archetypeLabel} (value ${u.valueScore})`).join("\n");
    const prompt  = `You are an organizational strategist for a software team.\n\nTop contributors:\n${topStr}\nCornerstones (key-person risk): ${cornerstones.map((u) => u.username).join(", ") || "none"}\nInvisible contributors (unrecognised): ${invisible.map((u) => u.username).join(", ") || "none"}\nBottlenecks: ${bottlenecks.map((u) => u.username).join(", ") || "none"}\n\nProvide 3 strategic org recommendations based on these archetypes. Focus on real business risk — key-person dependency, hidden talent recognition, blocker removal — with concrete quarterly actions.
Respond ONLY with valid JSON: {"insights":[{"title":"...","detail":"...","priority":"critical|high|medium"}]}`;
    const raw = await generateText({ prompt, maxTokens: 600, json: true });
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) aiInsights = normalizeInsights(JSON.parse(m[0]).insights);
  } catch (_) { /* degrade gracefully */ }

  return {
    users: analyzed,
    archetypeBreakdown: {
      cornerstone:           cornerstones.length,
      multiplier:            multipliers.length,
      invisible_contributor: invisible.length,
      bottleneck:            bottlenecks.length,
      solo_performer:        analyzed.filter((u) => u.archetype === "solo_performer").length,
      orchestrator:          analyzed.filter((u) => u.archetype === "orchestrator").length,
      contributor:           analyzed.filter((u) => u.archetype === "contributor").length,
    },
    keyRisks: {
      cornerstones:  cornerstones.map((u) => u.username),
      invisible:     invisible.map((u) => u.username),
      bottlenecks:   bottlenecks.map((u) => u.username),
    },
    aiInsights,
  };
}
