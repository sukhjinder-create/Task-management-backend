import pool from "../../db.js";
import { recordLearningSignal } from "../learning/learningEngine.service.js";
import { recommendationAcceptancePrior } from "../personalization/personalizationEngine.service.js";

async function taskSnapshot(client, { workspaceId, taskId }) {
  if (!taskId) return null;
  const { rows } = await client.query(
    `SELECT id, status, priority, assigned_to, due_date, updated_at
     FROM tasks
     WHERE workspace_id = $1 AND id = $2
     LIMIT 1`,
    [workspaceId, taskId]
  );
  return rows[0] || null;
}

async function projectSnapshot(client, { workspaceId, projectId }) {
  if (!projectId) return null;
  const { rows } = await client.query(
    `
    SELECT
      p.id,
      p.name,
      COUNT(t.id)::int AS total_tasks,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(t.status,'')) IN ('completed','done','closed'))::int AS completed_tasks,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(t.status,'')) IN ('blocked','on_hold','stuck'))::int AS blocked_tasks,
      COUNT(*) FILTER (
        WHERE t.due_date IS NOT NULL
          AND t.due_date < NOW()
          AND LOWER(COALESCE(t.status,'')) NOT IN ('completed','done','closed')
      )::int AS overdue_tasks
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id AND t.workspace_id = p.workspace_id
    WHERE p.workspace_id = $1 AND p.id = $2
    GROUP BY p.id, p.name
    LIMIT 1
    `,
    [workspaceId, projectId]
  );
  return rows[0] || null;
}

async function buildCausalBaseline(client, { workspaceId, action }) {
  const [task, project] = await Promise.all([
    taskSnapshot(client, { workspaceId, taskId: action.task_id }),
    projectSnapshot(client, { workspaceId, projectId: action.project_id }),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    action: {
      id: action.id,
      capabilityKey: action.capability_key,
      actionType: action.action_type,
      riskLevel: action.risk_level,
      approvalMode: action.approval_mode,
    },
    task,
    project,
  };
}

function projectHealthScore(snapshot) {
  const project = snapshot?.project;
  if (!project) return null;
  const total = Math.max(Number(project.total_tasks || 0), 1);
  const completed = Number(project.completed_tasks || 0);
  const overdue = Number(project.overdue_tasks || 0);
  const blocked = Number(project.blocked_tasks || 0);
  return Math.max(0, Math.min(1, (completed / total) - (overdue * 0.06) - (blocked * 0.08)));
}

function taskHealthScore(snapshot) {
  const task = snapshot?.task;
  if (!task) return null;
  const status = String(task.status || "").toLowerCase();
  if (["completed", "done", "closed"].includes(status)) return 1;
  if (["blocked", "on_hold", "stuck"].includes(status)) return 0.15;
  if (task.due_date && new Date(task.due_date).getTime() < Date.now()) return 0.25;
  if (task.assigned_to) return 0.55;
  return 0.4;
}

async function actualSnapshot(client, { workspaceId, baseline }) {
  const [task, project] = await Promise.all([
    taskSnapshot(client, { workspaceId, taskId: baseline?.task?.id }),
    projectSnapshot(client, { workspaceId, projectId: baseline?.project?.id }),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    task,
    project,
  };
}

function causalResult({ baseline, actual }) {
  const baselineTask = taskHealthScore(baseline);
  const actualTask = taskHealthScore(actual);
  const baselineProject = projectHealthScore(baseline);
  const actualProject = projectHealthScore(actual);
  const before = baselineTask ?? baselineProject ?? 0.5;
  const after = actualTask ?? actualProject ?? before;
  const delta = Math.round((after - before) * 1000) / 1000;
  return {
    improved: delta > 0.025,
    regressed: delta < -0.025,
    delta,
    before,
    after,
    method: baseline?.task ? "task_health_delta" : baseline?.project ? "project_delivery_health_delta" : "no_entity_baseline",
  };
}

export async function createRecommendationPrediction({
  workspaceId,
  runtimeRunId,
  eventId,
  action,
  actorUserId = null,
  evidence = [],
}) {
  const prior = await recommendationAcceptancePrior({ workspaceId, userId: actorUserId });
  const client = await pool.connect();
  try {
    const baseline = await buildCausalBaseline(client, { workspaceId, action });
    const predictionEvidence = [...evidence, { type: "personalization_prior", explanation: prior.explanation }];
    const { rows } = await client.query(
      `
      INSERT INTO adaptive_predictions (
        workspace_id, runtime_run_id, action_id, event_id, entity_type, entity_id,
        prediction_key, predicted_value, confidence, evidence, evaluate_after,
        baseline_snapshot, evaluation_strategy, causal_summary
      ) VALUES ($1,$2,$3,$4,'operations_action',$3,'recommendation.accepted',$5::jsonb,$6,$7::jsonb,NOW(),
        $8::jsonb,'acceptance_brier_score',$9::jsonb)
      RETURNING *
      `,
      [
        workspaceId,
        runtimeRunId,
        action.id,
        eventId,
        JSON.stringify({ accepted: prior.probability >= 0.5, probability: prior.probability, source: prior.source }),
        prior.probability,
        JSON.stringify(predictionEvidence),
        JSON.stringify(baseline),
        JSON.stringify({ baselineCaptured: true, causalEntity: baseline.task ? "task" : baseline.project ? "project" : "action" }),
      ]
    );
    if (baseline.task || baseline.project) {
      await client.query(
        `
        INSERT INTO adaptive_predictions (
          workspace_id, runtime_run_id, action_id, event_id, entity_type, entity_id,
          prediction_key, predicted_value, confidence, evidence, evaluate_after,
          baseline_snapshot, evaluation_strategy, causal_summary
        ) VALUES ($1,$2,$3,$4,$5,$6,'outcome.delivery_health_improves',$7::jsonb,$8,$9::jsonb,NOW() + INTERVAL '1 hour',
          $10::jsonb,'causal_baseline_delta',$11::jsonb)
        `,
        [
          workspaceId,
          runtimeRunId,
          action.id,
          eventId,
          baseline.task ? "task" : "project",
          baseline.task?.id || baseline.project?.id,
          JSON.stringify({ improves: true, probability: Math.max(0.35, Math.min(0.85, Number(action.outcome_confidence || action.confidence || 0.6))) }),
          Math.max(0.35, Math.min(0.85, Number(action.outcome_confidence || action.confidence || 0.6))),
          JSON.stringify(predictionEvidence),
          JSON.stringify(baseline),
          JSON.stringify({ baselineScore: taskHealthScore(baseline) ?? projectHealthScore(baseline), evaluated: false }),
        ]
      );
    }
    return rows[0];
  } finally {
    client.release();
  }
}

export async function evaluateActionPredictions({ workspaceId, actionId, accepted, actorUserId = null }) {
  const client = await pool.connect();
  const evaluated = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM adaptive_predictions
       WHERE workspace_id = $1 AND action_id = $2 AND status = 'pending'
       FOR UPDATE`,
      [workspaceId, actionId]
    );
    for (const prediction of rows) {
      const probability = Number(prediction.predicted_value?.probability ?? prediction.confidence ?? 0.5);
      const actual = accepted ? 1 : 0;
      const brierScore = (probability - actual) ** 2;
      const summary = `Acceptance probability ${probability.toFixed(3)}; actual ${accepted ? "accepted" : "not accepted"}; Brier score ${brierScore.toFixed(5)}.`;
      const { rows: updated } = await client.query(
        `UPDATE adaptive_predictions
         SET status = 'evaluated', actual_value = $1::jsonb, score = $2,
             evaluation_summary = $3, evaluated_at = NOW()
         WHERE id = $4 AND status = 'pending'
         RETURNING *`,
        [JSON.stringify({ accepted }), brierScore, summary, prediction.id]
      );
      if (!updated[0]) continue;
      evaluated.push(updated[0]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  for (const prediction of evaluated) {
    await recordLearningSignal({
      workspaceId,
      scopeType: "workspace",
      signalKey: "prediction.accuracy",
      signalValue: { predictionId: prediction.id, brierScore: prediction.score, accepted },
      source: "continuous_evaluation",
      runtimeRunId: prediction.runtime_run_id,
      actionId,
      actorUserId,
      confidence: Math.max(0, 1 - Number(prediction.score || 0)),
      idempotencyKey: `prediction:${prediction.id}:evaluation`,
    });
  }
  return evaluated;
}

export async function evaluateDueOutcomePredictions({ workspaceId = null, limit = 100, force = false } = {}) {
  const client = await pool.connect();
  const evaluated = [];
  try {
    await client.query("BEGIN");
    const params = [];
    const where = [
      "status = 'pending'",
      "prediction_key LIKE 'outcome.%'",
    ];
    if (!force) where.push("(evaluate_after IS NULL OR evaluate_after <= NOW())");
    if (workspaceId) {
      params.push(workspaceId);
      where.push(`workspace_id = $${params.length}`);
    }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    const limitParam = params.length;
    const { rows } = await client.query(
      `
      SELECT * FROM adaptive_predictions
      WHERE ${where.join(" AND ")}
      ORDER BY evaluate_after NULLS FIRST, predicted_at ASC
      LIMIT $${limitParam}
      FOR UPDATE SKIP LOCKED
      `,
      params
    );

    for (const prediction of rows) {
      const actual = await actualSnapshot(client, { workspaceId: prediction.workspace_id, baseline: prediction.baseline_snapshot });
      const result = causalResult({ baseline: prediction.baseline_snapshot, actual });
      const probability = Number(prediction.predicted_value?.probability ?? prediction.confidence ?? 0.5);
      const actualPositive = result.improved ? 1 : 0;
      const brierScore = (probability - actualPositive) ** 2;
      const summary = `Predicted delivery-health improvement probability ${probability.toFixed(3)}; actual delta ${result.delta.toFixed(3)} via ${result.method}; Brier score ${brierScore.toFixed(5)}.`;
      const { rows: updated } = await client.query(
        `
        UPDATE adaptive_predictions
        SET status = 'evaluated',
            actual_value = $1::jsonb,
            score = $2,
            evaluation_summary = $3,
            causal_summary = $4::jsonb,
            evaluated_at = NOW()
        WHERE id = $5 AND status = 'pending'
        RETURNING *
        `,
        [JSON.stringify({ actual, result }), brierScore, summary, JSON.stringify({ ...result, actual }), prediction.id]
      );
      if (updated[0]) {
        await client.query(
          `
          INSERT INTO adaptive_causal_evaluations (
            workspace_id, prediction_id, action_id, runtime_run_id, evaluation_key,
            baseline_snapshot, actual_snapshot, causal_claim, score, confidence,
            summary, evidence
          ) VALUES ($1,$2,$3,$4,'outcome.delivery_health_improves',$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb)
          ON CONFLICT (prediction_id) DO NOTHING
          `,
          [
            updated[0].workspace_id,
            updated[0].id,
            updated[0].action_id,
            updated[0].runtime_run_id,
            JSON.stringify(prediction.baseline_snapshot || {}),
            JSON.stringify(actual),
            JSON.stringify(result),
            brierScore,
            Math.max(0, 1 - brierScore),
            summary,
            JSON.stringify(prediction.evidence || []),
          ]
        );
        evaluated.push(updated[0]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  for (const prediction of evaluated) {
    await recordLearningSignal({
      workspaceId: prediction.workspace_id,
      scopeType: "workspace",
      signalKey: "prediction.accuracy",
      signalValue: {
        predictionId: prediction.id,
        predictionKey: prediction.prediction_key,
        brierScore: prediction.score,
        causalSummary: prediction.causal_summary,
      },
      source: "continuous_evaluation",
      runtimeRunId: prediction.runtime_run_id,
      actionId: prediction.action_id,
      confidence: Math.max(0, 1 - Number(prediction.score || 0)),
      idempotencyKey: `prediction:${prediction.id}:outcome-evaluation`,
    });
  }
  return evaluated;
}

export async function getEvaluationSummary(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'evaluated')::int AS evaluated,
      AVG(score) FILTER (WHERE status = 'evaluated') AS average_brier_score,
      AVG(1 - score) FILTER (WHERE status = 'evaluated') AS average_accuracy,
      COUNT(*) FILTER (WHERE prediction_key LIKE 'outcome.%')::int AS outcome_predictions
    FROM adaptive_predictions
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );
  return rows[0] || { pending: 0, evaluated: 0 };
}
