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
  const record =
    await intelligenceRepository.getMonthlyUserScore({
      workspaceId,
      userId,
      month,
    });

  if (!record) return null;

  // 🔹 Real-time behavioral metrics
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) AS total_tasks,

      COUNT(*) FILTER (WHERE status = 'completed') AS completed_tasks,

      COUNT(*) FILTER (
        WHERE status = 'completed'
        AND completed_at > due_date
      ) AS late_completions,

      COUNT(*) FILTER (
        WHERE status != 'completed'
        AND due_date < NOW()
      ) AS active_overdue,

      AVG(
        EXTRACT(EPOCH FROM (completed_at - created_at))
      ) FILTER (WHERE status = 'completed') AS avg_completion_time_seconds

    FROM tasks
    WHERE workspace_id = $1
      AND assigned_to = $2
    `,
    [workspaceId, userId]
  );

  const metrics = rows[0] || {};

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

  // Include external execution as bonus credit
const adjustedCompleted = completed + externalExecution;

// prevent division by zero
const adjustedTotal = Math.max(total, adjustedCompleted);

const executionDiscipline =
  adjustedTotal === 0
    ? 0
    : (adjustedCompleted / adjustedTotal) * 100;

  const timelinessIndex =
    completed === 0 ? 100 :
    (1 - late / completed) * 100;

  const workloadStress =
    total === 0 ? 0 :
    (overdue / total) * 100;

  const velocityScore =
    avgTime === 0 ? 50 :
    Math.max(0, 100 - (avgTime / 86400));

  // 🔹 Risk modeling
  const riskScore =
      0.30 * (100 - executionDiscipline)
    + 0.25 * (100 - timelinessIndex)
    + 0.25 * workloadStress
    + 0.20 * (100 - velocityScore);

  const riskProbability = Math.min(100, Math.max(0, riskScore));

  const riskLevel =
    riskProbability > 70 ? "High" :
    riskProbability > 40 ? "Medium" :
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

  if (timelinessIndex < 60)
    signals.push("Chronic deadline slippage");

  if (workloadStress > 60)
    signals.push("High workload stress");

  if (velocityScore < 40)
    signals.push("Slow task completion velocity");

  const dynamicCoaching = [];

if (executionDiscipline < 60) {
  dynamicCoaching.push(
    "Increase task completion consistency. Focus on closing existing tasks before taking new assignments."
  );
}

if (timelinessIndex < 70) {
  dynamicCoaching.push(
    "Improve deadline discipline. Review due dates daily and prioritize tasks nearing deadlines."
  );
}

if (workloadStress > 60) {
  dynamicCoaching.push(
    "High workload stress detected. Rebalance assignments or escalate workload constraints."
  );
}

if (velocityScore < 50) {
  dynamicCoaching.push(
    "Task completion velocity is slow. Break tasks into smaller milestones to improve flow."
  );
}

if (riskProbability > 70) {
  dynamicCoaching.push(
    "High performance risk detected. Immediate intervention and structured weekly review recommended."
  );
}

  return {
  score: record.score,
  explanation: record.reasoning?.summary || "",

  coaching: [
    ...(record.coaching || []),
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
