import pool from "../db.js";
import intelligenceRepository from "./intelligence.repository.js";
import { getExecutionMetrics } from "./executionIntelligence.service.js";

/**
 * IntelligenceService
 *
 * READ-ONLY
 * No writes
 * No cron
 * No AI calls
 */
class IntelligenceService {
  /**
   * USER — Monthly performance
   */
  async getUserPerformance({ workspaceId, userId, month }) {
  const requestedMonth = month || new Date().toISOString().slice(0, 7);
  let effectiveMonth = requestedMonth;
  let record =
    await intelligenceRepository.getMonthlyUserScore({
      workspaceId,
      userId,
      month: requestedMonth,
    });

  if (!record) {
    const latestRecord = await intelligenceRepository.getLatestMonthlyUserScore({
      workspaceId,
      userId,
    });
    if (latestRecord) {
      record = latestRecord;
      effectiveMonth = latestRecord.month;
    }
  }

  // 🔹 Real-time behavioral metrics
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) AS total_tasks,

      COUNT(*) FILTER (WHERE status = 'completed') AS completed_tasks,

      COUNT(*) FILTER (
        WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND due_date IS NOT NULL
        AND completed_at > due_date
      ) AS late_completions,

      COUNT(*) FILTER (
        WHERE status != 'completed'
        AND due_date < NOW()
      ) AS active_overdue,

      -- Unified timeliness: all tasks that have a due date
      COUNT(*) FILTER (WHERE due_date IS NOT NULL) AS tasks_with_due_date,

      -- On-time completions (completed before or on due date)
      COUNT(*) FILTER (
        WHERE status = 'completed'
        AND due_date IS NOT NULL
        AND completed_at IS NOT NULL
        AND completed_at <= due_date
      ) AS on_time_completions,

      AVG(
        EXTRACT(EPOCH FROM (completed_at - created_at))
      ) FILTER (WHERE status = 'completed') AS avg_completion_time_seconds

    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = $2
      AND project_id NOT IN (
        SELECT (metadata->>'projectId')::uuid
        FROM migration_imports
        WHERE workspace_id = $1
          AND source IN ('asana', 'youtrack')
          AND metadata->>'projectId' IS NOT NULL
      )
    `,
    [workspaceId, userId]
  );

  const metrics = rows[0] || {};

  // 🔹 Overdue task names (top 3)
  let overdueRows = [];
  try {
    const { rows: _o } = await pool.query(
      `
      SELECT title, due_date, priority
      FROM tasks
      WHERE workspace_id = $1
        AND assigned_to = $2
        AND status != 'completed'
        AND due_date IS NOT NULL
        AND due_date < NOW()
        AND (project_id IS NULL OR project_id NOT IN (
          SELECT (metadata->>'projectId')::uuid
          FROM migration_imports
          WHERE workspace_id = $1
            AND source IN ('asana', 'youtrack')
            AND metadata->>'projectId' IS NOT NULL
            AND metadata->>'projectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ))
      ORDER BY due_date ASC
      LIMIT 3
      `,
      [workspaceId, userId]
    );
    overdueRows = _o;
  } catch (_) { /* degrade gracefully */ }

  // 🔹 Slowest open tasks (in progress, >3 days old)
  let slowRows = [];
  try {
    const { rows: _s } = await pool.query(
      `
      SELECT title,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400)::int AS days_open
      FROM tasks
      WHERE workspace_id = $1
        AND assigned_to = $2
        AND status IN ('in-progress', 'in_progress')
        AND created_at < NOW() - INTERVAL '3 days'
        AND (project_id IS NULL OR project_id NOT IN (
          SELECT (metadata->>'projectId')::uuid
          FROM migration_imports
          WHERE workspace_id = $1
            AND source IN ('asana', 'youtrack')
            AND metadata->>'projectId' IS NOT NULL
            AND metadata->>'projectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ))
      ORDER BY days_open DESC
      LIMIT 3
      `,
      [workspaceId, userId]
    );
    slowRows = _s;
  } catch (_) { /* degrade gracefully */ }

  // 🔹 Last late completion task names (top 2)
  let lateRows = [];
  try {
    const { rows: _l } = await pool.query(
      `
      SELECT title,
        FLOOR(EXTRACT(EPOCH FROM (completed_at - due_date)) / 86400)::int AS days_late
      FROM tasks
      WHERE workspace_id = $1
        AND assigned_to = $2
        AND status = 'completed'
        AND completed_at IS NOT NULL
        AND due_date IS NOT NULL
        AND completed_at > due_date
        AND (project_id IS NULL OR project_id NOT IN (
          SELECT (metadata->>'projectId')::uuid
          FROM migration_imports
          WHERE workspace_id = $1
            AND source IN ('asana', 'youtrack')
            AND metadata->>'projectId' IS NOT NULL
            AND metadata->>'projectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ))
      ORDER BY completed_at DESC
      LIMIT 2
      `,
      [workspaceId, userId]
    );
    lateRows = _l;
  } catch (_) { /* degrade gracefully */ }

  // 🔥 External execution contribution
const executionMetrics =
  await getExecutionMetrics(workspaceId, month);

const externalExecution =
  executionMetrics.externalCompleted +
  executionMetrics.externalObservedCompletions;

  const total = Number(metrics.total_tasks) || 0;
  const completed = Number(metrics.completed_tasks) || 0;
  const late = Number(metrics.late_completions) || 0;
  const overdue = Number(metrics.active_overdue) || 0;
  const avgTime = Number(metrics.avg_completion_time_seconds) || 0;
  const tasksWithDue = Number(metrics.tasks_with_due_date) || 0;
  const onTime = Number(metrics.on_time_completions) || 0;

  // ── Execution Discipline ────────────────────────────────────────────────────
  // "What % of assigned tasks have you completed?"
  // External execution bonus removed — it added phantom completions that had
  // no basis in verifiable individual work and could artificially inflate scores.
  // External execution is now a signal only (surfaced in signals array below).
  const executionDiscipline = total === 0 ? 0 : (completed / total) * 100;

  // ── Timeliness (unified) ────────────────────────────────────────────────────
  // "Of all tasks that have a due date, what % were delivered on time?"
  // Denominator includes active overdue tasks — they count as "not on time".
  // Neutral (50) when no due dates are set: don't reward or penalise unmeasured work.
  const timelinessIndex =
    tasksWithDue === 0 ? 50 :
    (onTime / tasksWithDue) * 100;

  const workloadStress =
    total === 0 ? 0 :
    (overdue / total) * 100;

  // ── Velocity ────────────────────────────────────────────────────────────────
  // Hyperbolic decay referenced to a 7-day completion target.
  // 0 days→100, 3.5 days→67, 7 days→50, 14 days→33, 28 days→20.
  // Previous linear formula (100 − avgDays) barely distinguished the normal
  // 1–30 day range (scored 70–99), making velocity nearly meaningless.
  const velocityScore =
    (avgTime === 0 || completed === 0) ? 0 :
    Math.round(Math.max(0, 100 / (1 + (avgTime / 86400) / 7)));

  // ── Behavioural risk (real-time) ────────────────────────────────────────────
  const behaviouralRisk =
      0.30 * (100 - executionDiscipline)
    + 0.25 * (100 - timelinessIndex)
    + 0.25 * workloadStress
    + 0.20 * (100 - velocityScore);

  // ── Score-based risk (authoritative monthly) ────────────────────────────────
  // The monthly score is the official performance record.
  // Low score MUST raise risk — they cannot contradict each other.
  // score 10 → score risk 90 | score 80 → score risk 20
  const monthlyScore = record?.score ?? null;
  const scoreBasedRisk = monthlyScore !== null ? (100 - monthlyScore) : behaviouralRisk;

  // ── Unified risk: 55% real-time behaviour + 45% authoritative score ─────────
  const riskScore = behaviouralRisk * 0.55 + scoreBasedRisk * 0.45;

  // ── Score-based risk floor ────────────────────────────────────────────────
  // A critically low monthly score MUST produce High Risk regardless of
  // how good the real-time behavioural dimensions look.
  //   score ≤ 30  →  minimum 66% (firmly in High zone)
  //   score ≤ 50  →  minimum 36% (firmly in Medium zone)
  const riskFloor =
    monthlyScore !== null && monthlyScore <= 30 ? 66 :
    monthlyScore !== null && monthlyScore <= 50 ? 36 :
    0;

  const riskProbability = Math.min(100, Math.max(riskFloor, riskScore));

  const riskLevel =
    riskProbability > 65 ? "High"   :  // score ≤ 30 always lands here
    riskProbability > 35 ? "Medium" :
    "Low";

  // 🔹 Signals
  const signals = [];

  if (externalExecution > 0) {
  signals.push(
    `External execution detected (${externalExecution} completed outside Platform)`
  );
}

  if (executionDiscipline < 50)
    signals.push("Low execution discipline");

  if (total > 0 && completed === 0)
    signals.push("No tasks completed this month");

  if (timelinessIndex < 60 && completed > 0 && tasksWithDue > 0)
    signals.push("Chronic deadline slippage");

  if (workloadStress > 60)
    signals.push("High workload stress");

  if (velocityScore < 40 && completed > 0)
    signals.push("Slow task completion velocity");

  const dynamicCoaching = [];

  const avgDays = avgTime > 0 ? (avgTime / 86400).toFixed(1) : null;
  const openTasks = total - completed;

  // Helper: format task names as a quoted list
  const nameList = (rows) =>
    rows.map(r => `"${r.title}"`).join(", ");

  if (executionDiscipline < 60) {
    if (total > 0) {
      const overdueNames = overdueRows.length > 0
        ? ` Start with: ${nameList(overdueRows)}.`
        : "";
      dynamicCoaching.push(
        `Only ${completed} of ${total} tasks completed this month (${Math.round(executionDiscipline)}% rate). You have ${openTasks} open task${openTasks !== 1 ? "s" : ""} — close existing work before picking up new assignments.${overdueNames}`
      );
    } else {
      dynamicCoaching.push("No tasks completed yet this month. Pick up the highest-priority assigned task and move it to done before starting anything else.");
    }
  }

  if (timelinessIndex < 70 && completed > 0 && tasksWithDue > 0) {
    if (late > 0 && lateRows.length > 0) {
      const lateExamples = lateRows
        .map(r => `"${r.title}" (${r.days_late}d late)`)
        .join(", ");
      dynamicCoaching.push(
        `${late} of your ${completed} completed task${completed !== 1 ? "s were" : " was"} delivered late this month. Most recent: ${lateExamples}. Set a due-date reminder 48h in advance to break this pattern.`
      );
    } else if (late > 0) {
      dynamicCoaching.push(
        `${onTime} of ${tasksWithDue} deadline-tracked tasks delivered on time (${Math.round(timelinessIndex)}% timeliness). Add 48-hour reminders to all upcoming due dates.`
      );
    } else {
      dynamicCoaching.push("Deadline adherence is trending low. Review all open tasks with due dates and flag any that are at risk of slipping today.");
    }
  }

  if (workloadStress > 60) {
    if (overdueRows.length > 0) {
      const urgentList = overdueRows
        .map(r => {
          const daysAgo = Math.round((Date.now() - new Date(r.due_date)) / 86400000);
          return `"${r.title}" (${daysAgo}d overdue${r.priority ? `, ${r.priority}` : ""})`;
        })
        .join(", ");
      dynamicCoaching.push(
        `${overdue} task${overdue !== 1 ? "s are" : " is"} currently overdue (${Math.round(workloadStress)}% workload stress). Immediately action: ${urgentList}. Escalate to your manager anything blocked by a dependency.`
      );
    } else {
      dynamicCoaching.push(
        `Workload stress is at ${Math.round(workloadStress)}% — ${overdue} task${overdue !== 1 ? "s" : ""} overdue. Flag capacity constraints to your manager before accepting any new assignments.`
      );
    }
  }

  if (velocityScore < 50 && avgDays) {
    if (slowRows.length > 0) {
      const slowList = slowRows
        .map(r => `"${r.title}" (${r.days_open}d in progress)`)
        .join(", ");
      dynamicCoaching.push(
        `Average completion time is ${avgDays} days — too slow. Longest open tasks: ${slowList}. Break each into sub-tasks of 1–2 days max to unblock progress.`
      );
    } else {
      dynamicCoaching.push(
        `Average task completion time is ${avgDays} days. Break large tasks into sub-tasks of 1–2 days each to improve throughput and hit due dates.`
      );
    }
  }

  if (riskProbability > 70) {
    const focusList = overdueRows.length > 0
      ? ` This week: close ${nameList(overdueRows.slice(0, 2))}.`
      : ` Focus: close ${Math.min(openTasks, 3)} task${openTasks !== 1 ? "s" : ""} before end of week.`;
    dynamicCoaching.push(
      `Performance risk is at ${Math.round(riskProbability)}% (High zone). Schedule a 1:1 with your manager to surface blockers.${focusList}`
    );
  }

  // Fallback score computed from real-time behavioral dimensions when no monthly record exists
  const computedScore = Math.round(
    executionDiscipline * 0.35 +
    timelinessIndex * 0.30 +
    (100 - workloadStress) * 0.20 +
    velocityScore * 0.15
  );

  return {
  requestedMonth,
  effectiveMonth,
  scoreSource: record ? "workspace_monthly_scores" : "live_computed",
  score: record?.score ?? computedScore,
  explanation: record?.reasoning?.summary || "",

  // Score composition from last monthly run (attendance + productivity sub-scores)
  breakdown: record?.breakdown ?? null,

  coaching: [
    ...(record?.coaching || []),
    ...dynamicCoaching
  ],

  intelligence: {
    dimensions: {
      executionDiscipline,
      timelinessIndex,
      workloadStress,
      velocityScore,
    },
    risk: {
      probability: riskProbability,
      level: riskLevel,
    },
    signals,
  },
};}

  /**
   * ADMIN — Org-level insights
   */
  async getAdminInsights({ workspaceId, month }) {
    return intelligenceRepository.getAdminInsights({
      workspaceId,
      month,
    });
  }

  /**
   * ADMIN — Executive summary
   */
  async getExecutiveSummary({ workspaceId, month }) {
    return intelligenceRepository.getExecutiveSummary({
      workspaceId,
      month,
    });
  }

  /**
   * ADMIN — Coaching effectiveness (Phase 4)
   */
  async getCoachingEffectiveness({ workspaceId, month }) {
    const { rows } = await pool.query(
      `
      SELECT
        nudge_type,
        outcome,
        COUNT(*)::int AS count
      FROM workspace_coaching_effectiveness
      WHERE workspace_id = $1
        AND date_trunc('month', evaluated_at) =
            date_trunc('month', $2::date)
      GROUP BY nudge_type, outcome
      ORDER BY nudge_type, outcome
      `,
      [workspaceId, `${month}-01`]
    );

    return rows;
  }

  async getUserTrend({ workspaceId, userId }) {
  const { rows } = await pool.query(
    `
    SELECT month, score
    FROM workspace_monthly_scores
    WHERE workspace_id = $1
      AND user_id = $2
    ORDER BY month ASC
    `,
    [workspaceId, userId]
  );

  return rows;
}

async getUserProjectPerformance({ workspaceId, userId }) {
  const { rows } = await pool.query(
    `
    SELECT project_id, month, score
    FROM workspace_project_monthly_scores
    WHERE workspace_id = $1
      AND user_id = $2
    ORDER BY month DESC
    `,
    [workspaceId, userId]
  );

  return rows;
}
}

export default new IntelligenceService();
