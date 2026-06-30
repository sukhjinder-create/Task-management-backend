import pool from "../../db.js";
import { listCapabilities } from "../capabilities/capabilityRegistry.js";
import { listContextProviders } from "../context/contextRegistry.js";
import { getEvaluationSummary } from "../evaluation/evaluationEngine.service.js";
import { getAdaptiveWorkerDiagnostics } from "../runtime/adaptiveWorker.service.js";
import { listObservers } from "../../events/eventBus.js";
import { getAdaptiveQueueMetrics } from "../events/eventQueue.repository.js";

export async function listRuntimeRuns({ workspaceId, status = null, limit = 50 }) {
  const params = [workspaceId];
  const where = ["workspace_id = $1"];
  let index = 2;
  if (status) { where.push(`status = $${index++}`); params.push(status); }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await pool.query(
    `SELECT * FROM adaptive_runtime_runs
     WHERE ${where.join(" AND ")}
     ORDER BY started_at DESC LIMIT $${index}`,
    params
  );
  return rows;
}

export async function getRuntimeRun({ workspaceId, runId }) {
  const [runResult, invocationResult, workflowResult] = await Promise.all([
    pool.query(`SELECT * FROM adaptive_runtime_runs WHERE id = $1 AND workspace_id = $2`, [runId, workspaceId]),
    pool.query(`SELECT * FROM adaptive_capability_invocations WHERE runtime_run_id = $1 AND workspace_id = $2 ORDER BY started_at`, [runId, workspaceId]),
    pool.query(`SELECT * FROM adaptive_workflow_runs WHERE runtime_run_id = $1 AND workspace_id = $2 ORDER BY started_at`, [runId, workspaceId]),
  ]);
  if (!runResult.rows[0]) return null;
  return { ...runResult.rows[0], invocations: invocationResult.rows, workflows: workflowResult.rows };
}

export async function listExecutionPlans({ workspaceId, status = null, limit = 50 }) {
  const params = [workspaceId];
  const where = ["workspace_id = $1"];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await pool.query(
    `SELECT * FROM adaptive_execution_plans WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function getExecutionPlan({ workspaceId, planId }) {
  const [plan, steps] = await Promise.all([
    pool.query(`SELECT * FROM adaptive_execution_plans WHERE id = $1 AND workspace_id = $2`, [planId, workspaceId]),
    pool.query(
      `SELECT s.*, a.title, a.summary, a.explanation, a.evidence, a.approval_mode,
              a.approved_by, a.approved_at, a.executed_at, a.result
       FROM adaptive_execution_plan_steps s
       LEFT JOIN operations_ai_actions a ON a.id = s.action_id AND a.workspace_id = s.workspace_id
       WHERE s.plan_id = $1 AND s.workspace_id = $2 ORDER BY s.step_index`,
      [planId, workspaceId]
    ),
  ]);
  return plan.rows[0] ? { ...plan.rows[0], steps: steps.rows } : null;
}

export async function listPredictionHistory({ workspaceId, limit = 100 }) {
  const { rows } = await pool.query(
    `SELECT p.*, a.title AS action_title, a.action_type, a.capability_key,
            a.rule_confidence, a.outcome_confidence, a.acceptance_probability
     FROM adaptive_predictions p
     LEFT JOIN operations_ai_actions a ON a.id = p.action_id AND a.workspace_id = p.workspace_id
     WHERE p.workspace_id = $1 ORDER BY p.predicted_at DESC LIMIT $2`,
    [workspaceId, Math.min(Math.max(Number(limit) || 100, 1), 250)]
  );
  return rows;
}

export async function getAdaptivePlatformHealth({ workspaceId, settings }) {
  const [queueResult, queueMetrics, runResult, actionResult, distributedWorkers, evaluation] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM adaptive_event_queue
       WHERE workspace_id = $1 GROUP BY status`,
      [workspaceId]
    ),
    getAdaptiveQueueMetrics(workspaceId),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours')::int AS runs_24h,
         COUNT(*) FILTER (WHERE status = 'failed' AND started_at >= NOW() - INTERVAL '24 hours')::int AS failed_24h,
         AVG((timings->>'totalMs')::numeric) FILTER (WHERE timings ? 'totalMs') AS average_duration_ms,
         MAX(completed_at) AS last_completed_at
       FROM adaptive_runtime_runs WHERE workspace_id = $1`,
      [workspaceId]
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM operations_ai_actions
       WHERE workspace_id = $1 AND source = 'adaptive_runtime' GROUP BY status`,
      [workspaceId]
    ),
    pool.query(
      `SELECT worker_id, started_at, heartbeat_at, status, cycles, processed, failed, diagnostics
       FROM adaptive_worker_heartbeats
       WHERE heartbeat_at >= NOW() - INTERVAL '30 seconds'
       ORDER BY heartbeat_at DESC`
    ).catch((error) => error?.code === "42P01" ? { rows: [] } : Promise.reject(error)),
    getEvaluationSummary(workspaceId),
  ]);
  const worker = getAdaptiveWorkerDiagnostics();
  const lagSloSeconds = Math.max(Number(settings?.policy?.queueLagSloSeconds) || 60, 10);
  const workerRequired = ["assist", "auto"].includes(settings.mode);
  const degradedReasons = [];
  const activeDistributedWorkers = distributedWorkers.rows || [];
  if (workerRequired && !worker.enabled && activeDistributedWorkers.length === 0) degradedReasons.push("worker_disabled");
  if (queueMetrics.oldestLagSeconds > lagSloSeconds) degradedReasons.push("queue_lag_slo_exceeded");
  if (queueMetrics.deadLetters > 0) degradedReasons.push("dead_letters_present");
  return {
    status: degradedReasons.length ? "degraded" : "available",
    degradedReasons,
    mode: settings.mode,
    settingsVersion: settings.version,
    eventQueue: {
      ...Object.fromEntries(queueResult.rows.map((row) => [row.status, row.count])),
      ...queueMetrics,
      lagSloSeconds,
    },
    runs: runResult.rows[0] || {},
    recommendations: Object.fromEntries(actionResult.rows.map((row) => [row.status, row.count])),
    evaluation,
    worker: { ...worker, activeDistributedWorkers },
    registry: {
      capabilities: listCapabilities(),
      contextProviders: listContextProviders(),
      observers: listObservers(),
    },
  };
}

export async function listAdaptiveRecommendations({ workspaceId, userId, role, status = "pending", limit = 20, projectId = null, taskId = null }) {
  const params = [workspaceId];
  const where = ["a.workspace_id = $1", "a.source = 'adaptive_runtime'"];
  let index = 2;
  if (status && status !== "all") { where.push(`a.status = $${index++}`); params.push(status); }
  if (projectId) { where.push(`a.project_id = $${index++}`); params.push(projectId); }
  if (taskId) { where.push(`a.task_id = $${index++}`); params.push(taskId); }
  if (!["admin", "owner", "manager"].includes(role)) {
    where.push(`(a.target_user_id = $${index} OR a.created_by = $${index})`);
    params.push(userId);
    index += 1;
  }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const { rows } = await pool.query(
    `
    SELECT a.*, u.username AS target_user_name, p.name AS project_name, t.task AS task_title
    FROM operations_ai_actions a
    LEFT JOIN users u ON u.id = a.target_user_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE ${where.join(" AND ")}
    ORDER BY a.created_at DESC
    LIMIT $${index}
    `,
    params
  );
  return rows;
}
