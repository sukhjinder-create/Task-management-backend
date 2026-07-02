-- Asystence Adaptive Intelligence Evaluation Platform (AIEP)
-- Additive-only evaluation and reporting layer. This migration does not alter
-- recommendation, workflow, approval, or execution behaviour.

CREATE TABLE IF NOT EXISTS adaptive_intelligence_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id UUID REFERENCES operations_ai_actions(id) ON DELETE SET NULL,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  event_id UUID REFERENCES workspace_events(id) ON DELETE SET NULL,
  execution_plan_id UUID REFERENCES adaptive_execution_plans(id) ON DELETE SET NULL,
  workflow_run_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  lifecycle JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation_category TEXT NOT NULL DEFAULT 'Operational assistance',
  strategy_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  capability_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  business_outcomes JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_calibration JSONB NOT NULL DEFAULT '{}'::jsonb,
  learning_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  explainability JSONB NOT NULL DEFAULT '{}'::jsonb,
  effectiveness_score NUMERIC(5,4) NOT NULL DEFAULT 0.5000,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluation_window TEXT NOT NULL DEFAULT 'recent_action',
  idempotency_key TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, idempotency_key),
  CONSTRAINT adaptive_intelligence_evaluations_score_check
    CHECK (effectiveness_score >= 0 AND effectiveness_score <= 1)
);

CREATE INDEX IF NOT EXISTS idx_adaptive_intelligence_evaluations_workspace
  ON adaptive_intelligence_evaluations(workspace_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_adaptive_intelligence_evaluations_action
  ON adaptive_intelligence_evaluations(workspace_id, action_id)
  WHERE action_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_adaptive_intelligence_evaluations_category
  ON adaptive_intelligence_evaluations(workspace_id, recommendation_category, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_adaptive_intelligence_evaluations_context
  ON adaptive_intelligence_evaluations USING gin(context_summary);

CREATE TABLE IF NOT EXISTS adaptive_intelligence_metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by TEXT NOT NULL DEFAULT 'aiep_evaluation_engine',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_intelligence_metric_snapshots_scope_check
    CHECK (
      (scope_type = 'workspace' AND workspace_id IS NOT NULL)
      OR (scope_type = 'platform' AND workspace_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_intelligence_metric_snapshot_unique
  ON adaptive_intelligence_metric_snapshots(
    scope_type,
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    snapshot_key,
    window_start,
    window_end
  );

CREATE INDEX IF NOT EXISTS idx_adaptive_intelligence_metric_snapshots_recent
  ON adaptive_intelligence_metric_snapshots(scope_type, workspace_id, created_at DESC);

ALTER TABLE adaptive_intelligence_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_intelligence_metric_snapshots ENABLE ROW LEVEL SECURITY;
