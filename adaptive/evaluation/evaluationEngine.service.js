import pool from "../../db.js";
import { recordLearningSignal } from "../learning/learningEngine.service.js";
import { recommendationAcceptancePrior } from "../personalization/personalizationEngine.service.js";

export async function createRecommendationPrediction({
  workspaceId,
  runtimeRunId,
  eventId,
  action,
  actorUserId = null,
  evidence = [],
}) {
  const prior = await recommendationAcceptancePrior({ workspaceId, userId: actorUserId });
  const { rows } = await pool.query(
    `
    INSERT INTO adaptive_predictions (
      workspace_id, runtime_run_id, action_id, event_id, entity_type, entity_id,
      prediction_key, predicted_value, confidence, evidence, evaluate_after
    ) VALUES ($1,$2,$3,$4,'operations_action',$3,'recommendation.accepted',$5::jsonb,$6,$7::jsonb,NOW())
    RETURNING *
    `,
    [
      workspaceId,
      runtimeRunId,
      action.id,
      eventId,
      JSON.stringify({ accepted: prior.probability >= 0.5, probability: prior.probability, source: prior.source }),
      prior.probability,
      JSON.stringify([...evidence, { type: "personalization_prior", explanation: prior.explanation }]),
    ]
  );
  return rows[0];
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

export async function getEvaluationSummary(workspaceId) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'evaluated')::int AS evaluated,
      AVG(score) FILTER (WHERE status = 'evaluated') AS average_brier_score,
      AVG(1 - score) FILTER (WHERE status = 'evaluated') AS average_accuracy
    FROM adaptive_predictions
    WHERE workspace_id = $1
    `,
    [workspaceId]
  );
  return rows[0] || { pending: 0, evaluated: 0 };
}
