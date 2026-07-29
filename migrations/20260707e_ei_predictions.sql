-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Phase 5: immutable predictions
--  Additive & idempotent. Append-only, idempotent by prediction_id, versioned.
--  Every prediction references a reasoning trace. NOT executed by this phase.
--  Rollback: DROP TABLE IF EXISTS ei_predictions;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_predictions (
  id                    BIGSERIAL PRIMARY KEY,
  prediction_id         TEXT NOT NULL UNIQUE,
  workspace_id          TEXT NOT NULL,
  entity_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
  prediction_type       TEXT NOT NULL,
  prediction_value      TEXT,
  probability           NUMERIC(8,6),
  confidence_low        NUMERIC(8,6),
  confidence_high       NUMERIC(8,6),
  horizon_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  reasoning_trace_id    TEXT NOT NULL,
  alternative_outcomes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_uncertainty_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  unknown_factors_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  historical_performance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version        INTEGER NOT NULL DEFAULT 1,
  engine_version        TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_pred_ws ON ei_predictions (workspace_id, prediction_type);
CREATE INDEX IF NOT EXISTS idx_ei_pred_trace ON ei_predictions (reasoning_trace_id);
