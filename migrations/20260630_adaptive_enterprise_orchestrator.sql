-- Asystence Adaptive Enterprise Orchestrator completion (additive only).

ALTER TABLE operations_ai_actions
  ADD COLUMN IF NOT EXISTS rule_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS prediction_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS outcome_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS acceptance_probability NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS execution_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS personalization_scope TEXT,
  ADD COLUMN IF NOT EXISTS personalization_source TEXT,
  ADD COLUMN IF NOT EXISTS execution_plan_id UUID;

CREATE TABLE IF NOT EXISTS adaptive_execution_plans (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime_run_id UUID REFERENCES adaptive_runtime_runs(id) ON DELETE SET NULL,
  event_id UUID REFERENCES workspace_events(id) ON DELETE SET NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  total_steps INTEGER NOT NULL DEFAULT 0,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  failed_steps INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT adaptive_execution_plans_status_check
    CHECK (status IN ('proposed','approval_pending','running','partial','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_execution_plans_workspace
  ON adaptive_execution_plans(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS adaptive_execution_plan_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES adaptive_execution_plans(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  capability_key TEXT NOT NULL,
  action_id UUID REFERENCES operations_ai_actions(id) ON DELETE SET NULL,
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'proposed',
  compensation JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(plan_id, step_index),
  CONSTRAINT adaptive_execution_plan_steps_status_check
    CHECK (status IN ('proposed','approval_pending','approved','running','completed','failed','compensated','skipped'))
);

DO $$ BEGIN
  ALTER TABLE operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_execution_plan_fk
    FOREIGN KEY (execution_plan_id) REFERENCES adaptive_execution_plans(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_approval_execution_check
    CHECK (
      status <> 'executed'
      OR approval_mode = 'automatic'
      OR (status = 'executed' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE operations_ai_actions
  VALIDATE CONSTRAINT operations_ai_actions_approval_execution_check;

CREATE TABLE IF NOT EXISTS adaptive_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'healthy',
  cycles BIGINT NOT NULL DEFAULT 0,
  processed BIGINT NOT NULL DEFAULT 0,
  failed BIGINT NOT NULL DEFAULT 0,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT adaptive_worker_heartbeats_status_check
    CHECK (status IN ('healthy','degraded','stopping'))
);

CREATE INDEX IF NOT EXISTS idx_adaptive_worker_heartbeats_recent
  ON adaptive_worker_heartbeats(heartbeat_at DESC);

ALTER TABLE adaptive_execution_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_execution_plan_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_worker_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_operations_ai_actions_plan
  ON operations_ai_actions(workspace_id, execution_plan_id, created_at)
  WHERE execution_plan_id IS NOT NULL;
