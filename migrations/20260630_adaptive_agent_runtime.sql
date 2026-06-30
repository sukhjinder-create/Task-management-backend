-- Asystence Adaptive Agent Runtime v1
-- Additive, tenant-scoped foundation. Runtime rollback is performed by setting
-- adaptive_runtime_settings.mode to 'off'; no existing product table is replaced.

ALTER TABLE workspace_events
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS causation_id UUID,
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;

UPDATE workspace_events
SET occurred_at = COALESCE(occurred_at, created_at, NOW())
WHERE occurred_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace_occurred
  ON workspace_events(workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace_type_occurred
  ON workspace_events(workspace_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_events_correlation
  ON workspace_events(workspace_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS adaptive_runtime_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'shadow',
  event_capture_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  workflow_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_approval_mode TEXT NOT NULL DEFAULT 'approval_required',
  enabled_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_limits JSONB NOT NULL DEFAULT '{"memoryEntries":10,"timeoutMs":2500}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_runtime_settings_mode_check
    CHECK (mode IN ('off', 'shadow', 'assist', 'auto')),
  CONSTRAINT adaptive_runtime_settings_approval_check
    CHECK (default_approval_mode IN ('automatic', 'approval_required', 'manual_only'))
);

CREATE TABLE IF NOT EXISTS adaptive_event_queue (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES workspace_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE(event_id),
  CONSTRAINT adaptive_event_queue_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_event_queue_ready
  ON adaptive_event_queue(status, available_at, id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_adaptive_event_queue_workspace
  ON adaptive_event_queue(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_runtime_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id UUID REFERENCES workspace_events(id) ON DELETE SET NULL,
  queue_id BIGINT REFERENCES adaptive_event_queue(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  trigger_type TEXT NOT NULL DEFAULT 'event',
  context_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasoning_summary TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation_count INTEGER NOT NULL DEFAULT 0,
  trace_id UUID NOT NULL DEFAULT gen_random_uuid(),
  correlation_id UUID,
  timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT adaptive_runtime_runs_mode_check
    CHECK (mode IN ('off', 'shadow', 'assist', 'auto')),
  CONSTRAINT adaptive_runtime_runs_status_check
    CHECK (status IN ('started', 'completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_runtime_runs_workspace_started
  ON adaptive_runtime_runs(workspace_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_adaptive_runtime_runs_event
  ON adaptive_runtime_runs(event_id, started_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_capability_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  capability_key TEXT NOT NULL,
  capability_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'started',
  approval_mode TEXT NOT NULL DEFAULT 'approval_required',
  idempotency_key TEXT,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT adaptive_capability_invocations_status_check
    CHECK (status IN ('started', 'succeeded', 'failed', 'proposed', 'denied')),
  CONSTRAINT adaptive_capability_invocations_approval_check
    CHECK (approval_mode IN ('automatic', 'approval_required', 'manual_only'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_capability_invocations_idempotency
  ON adaptive_capability_invocations(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_adaptive_capability_invocations_run
  ON adaptive_capability_invocations(runtime_run_id, started_at);

CREATE TABLE IF NOT EXISTS adaptive_workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  definition JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, workflow_key, version),
  CONSTRAINT adaptive_workflow_definitions_status_check
    CHECK (status IN ('draft', 'active', 'paused', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_workflow_one_active_version
  ON adaptive_workflow_definitions(workspace_id, workflow_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS adaptive_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_definition_id UUID NOT NULL REFERENCES adaptive_workflow_definitions(id) ON DELETE RESTRICT,
  workflow_version INTEGER NOT NULL,
  event_id UUID REFERENCES workspace_events(id) ON DELETE SET NULL,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_step INTEGER NOT NULL DEFAULT 0,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  resume_after TIMESTAMPTZ,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT adaptive_workflow_runs_status_check
    CHECK (status IN ('running', 'waiting', 'approval_pending', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_workflow_runs_ready
  ON adaptive_workflow_runs(status, resume_after)
  WHERE status IN ('running', 'waiting');

CREATE INDEX IF NOT EXISTS idx_adaptive_workflow_runs_workspace
  ON adaptive_workflow_runs(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_workflow_step_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES adaptive_workflow_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(workflow_run_id, step_index),
  CONSTRAINT adaptive_workflow_step_type_check
    CHECK (step_type IN ('WHEN', 'IF', 'THEN', 'WAIT', 'APPROVAL', 'END')),
  CONSTRAINT adaptive_workflow_step_status_check
    CHECK (status IN ('started', 'succeeded', 'skipped', 'waiting', 'approval_pending', 'failed'))
);

CREATE TABLE IF NOT EXISTS adaptive_learning_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id UUID,
  signal_key TEXT NOT NULL,
  signal_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  action_id UUID REFERENCES operations_ai_actions(id) ON DELETE SET NULL,
  event_id UUID REFERENCES workspace_events(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  confidence NUMERIC(4,3),
  status TEXT NOT NULL DEFAULT 'active',
  idempotency_key TEXT,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_learning_signals_scope_check
    CHECK (scope_type IN ('user', 'team', 'project', 'department', 'workspace', 'enterprise')),
  CONSTRAINT adaptive_learning_signals_status_check
    CHECK (status IN ('active', 'reversed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_learning_signal_idempotency
  ON adaptive_learning_signals(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_adaptive_learning_signals_scope
  ON adaptive_learning_signals(workspace_id, scope_type, scope_id, signal_key, created_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_preference_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id UUID,
  profile_key TEXT NOT NULL,
  profile_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  explanation TEXT,
  last_signal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adaptive_preference_profiles_scope_check
    CHECK (scope_type IN ('user', 'team', 'project', 'department', 'workspace', 'enterprise'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_adaptive_preference_profiles_unique_scope
  ON adaptive_preference_profiles(
    workspace_id,
    scope_type,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    profile_key
  );

CREATE TABLE IF NOT EXISTS adaptive_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  action_id UUID REFERENCES operations_ai_actions(id) ON DELETE SET NULL,
  event_id UUID REFERENCES workspace_events(id) ON DELETE SET NULL,
  entity_type TEXT,
  entity_id UUID,
  prediction_key TEXT NOT NULL,
  predicted_value JSONB NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  evaluate_after TIMESTAMPTZ,
  actual_value JSONB,
  score NUMERIC(8,5),
  evaluation_summary TEXT,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ,
  CONSTRAINT adaptive_predictions_status_check
    CHECK (status IN ('pending', 'evaluated', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_predictions_due
  ON adaptive_predictions(status, evaluate_after)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_adaptive_predictions_workspace
  ON adaptive_predictions(workspace_id, predicted_at DESC);

ALTER TABLE operations_ai_actions
  ADD COLUMN IF NOT EXISTS adaptive_runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capability_key TEXT,
  ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'approval_required',
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_ai_actions_adaptive_idempotency
  ON operations_ai_actions(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_ai_actions_adaptive_runtime
  ON operations_ai_actions(adaptive_runtime_run_id, created_at DESC)
  WHERE adaptive_runtime_run_id IS NOT NULL;

ALTER TABLE adaptive_runtime_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_event_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_runtime_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_capability_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_workflow_step_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_learning_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_preference_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_predictions ENABLE ROW LEVEL SECURITY;
