// ei/prediction/store.js
//
// EI V2.1 Phase 5 — immutable prediction store. Append-only, idempotent by
// prediction_id, versioned. Schema-tolerant. UNVERIFIED AT RUNTIME.

import { q } from "../../ai-platform/studio/db.js";

export async function appendPrediction(p) {
  if (!p || !p.predictionId || !p.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_predictions
       (prediction_id, workspace_id, entity_json, prediction_type, prediction_value, probability,
        confidence_low, confidence_high, horizon_json, reasoning_trace_id, alternative_outcomes_json,
        assumptions_json, observed_uncertainty_json, unknown_factors_json, historical_performance_json,
        provenance_json, schema_version, engine_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (prediction_id) DO NOTHING
     RETURNING prediction_id`,
    [
      p.predictionId, p.workspaceId, JSON.stringify(p.entity || {}), p.predictionType, p.predictionValue,
      p.probability, p.confidenceInterval?.low ?? null, p.confidenceInterval?.high ?? null,
      JSON.stringify(p.predictionHorizon || {}), p.supportingReasoningTraceId,
      JSON.stringify(p.alternativeOutcomes || []), JSON.stringify(p.assumptions || []),
      JSON.stringify(p.observedUncertainty || {}), JSON.stringify(p.unknownFactors || {}),
      JSON.stringify(p.historicalPerformance || {}), JSON.stringify(p.provenance || {}),
      p.schemaVersion || 1, p.provenance?.engineVersion || null,
    ]
  );
  return rows[0]?.prediction_id ?? null;
}

export async function listPredictions({ workspaceId, predictionType = null, limit = 200 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_predictions WHERE workspace_id = $1 AND ($2::text IS NULL OR prediction_type = $2)
      ORDER BY prediction_id LIMIT $3`,
    [workspaceId, predictionType, Math.min(Number(limit) || 200, 1000)]
  );
  return rows;
}
