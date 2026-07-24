-- Asystence V1 Final Intelligence Completion
-- Additive-only intelligence layer on top of AIEP, Adaptive Runtime, Learning,
-- Workflow, and existing observability. This migration does not alter
-- recommendation generation, approval enforcement, or workflow execution.

CREATE TABLE IF NOT EXISTS adaptive_intelligence_coach_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'workspace',
  scope_id UUID,
  insight_key TEXT NOT NULL,
  insight_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_business_impact TEXT,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0.5000,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_intelligence_coach_scope_check
    CHECK (
      (scope_type IN ('workspace','team','project','department','pilot') AND workspace_id IS NOT NULL)
      OR (scope_type = 'platform' AND workspace_id IS NULL)
    ),
  CONSTRAINT adaptive_intelligence_coach_severity_check
    CHECK (severity IN ('info','positive','attention','critical')),
  CONSTRAINT adaptive_intelligence_coach_status_check
    CHECK (status IN ('active','archived','dismissed')),
  CONSTRAINT adaptive_intelligence_coach_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_intelligence_coach_active_key
  ON adaptive_intelligence_coach_insights(
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    insight_key
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_adaptive_intelligence_coach_workspace
  ON adaptive_intelligence_coach_insights(workspace_id, updated_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS adaptive_strategy_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id UUID,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  experiment_type TEXT NOT NULL DEFAULT 'strategy_comparison',
  variants JSONB NOT NULL,
  primary_metric TEXT NOT NULL DEFAULT 'effectiveness',
  secondary_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  minimum_sample_size INTEGER NOT NULL DEFAULT 20,
  meaningful_delta NUMERIC(5,4) NOT NULL DEFAULT 0.0800,
  status TEXT NOT NULL DEFAULT 'draft',
  guardrails JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_strategy_experiments_scope_check
    CHECK (
      (scope_type IN ('workspace','department','pilot') AND workspace_id IS NOT NULL)
      OR (scope_type = 'platform' AND workspace_id IS NULL)
    ),
  CONSTRAINT adaptive_strategy_experiments_status_check
    CHECK (status IN ('draft','active','paused','completed','archived')),
  CONSTRAINT adaptive_strategy_experiments_sample_check
    CHECK (minimum_sample_size >= 5 AND minimum_sample_size <= 10000),
  CONSTRAINT adaptive_strategy_experiments_delta_check
    CHECK (meaningful_delta > 0 AND meaningful_delta <= 1)
);

CREATE INDEX IF NOT EXISTS idx_adaptive_strategy_experiments_workspace
  ON adaptive_strategy_experiments(workspace_id, status, updated_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS adaptive_strategy_experiment_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES adaptive_strategy_experiments(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  variant_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adaptive_strategy_experiment_results_recent
  ON adaptive_strategy_experiment_results(experiment_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_memory_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'workspace',
  scope_id UUID,
  pattern_key TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  pattern_summary TEXT NOT NULL,
  business_label TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_use TEXT,
  direction TEXT NOT NULL DEFAULT 'observe',
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0.5000,
  sample_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'adaptive_memory_evolution',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_memory_patterns_scope_check
    CHECK (scope_type IN ('user','team','project','department','workspace','enterprise')),
  CONSTRAINT adaptive_memory_patterns_direction_check
    CHECK (direction IN ('prefer','avoid','improve','observe')),
  CONSTRAINT adaptive_memory_patterns_status_check
    CHECK (status IN ('active','reversed','archived')),
  CONSTRAINT adaptive_memory_patterns_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_memory_patterns_active_key
  ON adaptive_memory_patterns(
    workspace_id,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    pattern_key
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_adaptive_memory_patterns_workspace
  ON adaptive_memory_patterns(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_universal_explanations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id UUID,
  action_id UUID REFERENCES operations_ai_actions(id) ON DELETE SET NULL,
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by TEXT NOT NULL DEFAULT 'universal_explainability_v1',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adaptive_universal_explanations_subject
  ON adaptive_universal_explanations(workspace_id, subject_type, subject_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_adaptive_universal_explanations_action
  ON adaptive_universal_explanations(workspace_id, action_id, generated_at DESC)
  WHERE action_id IS NOT NULL;

ALTER TABLE adaptive_intelligence_coach_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_strategy_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_strategy_experiment_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_memory_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_universal_explanations ENABLE ROW LEVEL SECURITY;
