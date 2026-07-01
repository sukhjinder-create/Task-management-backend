-- Adaptive Enterprise Orchestrator pilot-maturity additions (additive only).

ALTER TABLE adaptive_predictions
  ADD COLUMN IF NOT EXISTS baseline_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evaluation_strategy TEXT,
  ADD COLUMN IF NOT EXISTS causal_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_adaptive_predictions_outcome_due
  ON adaptive_predictions(workspace_id, status, evaluate_after)
  WHERE status = 'pending' AND prediction_key LIKE 'outcome.%';

CREATE TABLE IF NOT EXISTS adaptive_causal_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prediction_id UUID NOT NULL REFERENCES adaptive_predictions(id) ON DELETE CASCADE,
  action_id UUID REFERENCES operations_ai_actions(id) ON DELETE SET NULL,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  evaluation_key TEXT NOT NULL,
  baseline_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  actual_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  causal_claim JSONB NOT NULL DEFAULT '{}'::jsonb,
  score NUMERIC(8,5),
  confidence NUMERIC(4,3),
  summary TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(prediction_id)
);

CREATE INDEX IF NOT EXISTS idx_adaptive_causal_evaluations_workspace
  ON adaptive_causal_evaluations(workspace_id, created_at DESC);

ALTER TABLE adaptive_causal_evaluations ENABLE ROW LEVEL SECURITY;
