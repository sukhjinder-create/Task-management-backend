-- Enterprise Assurance Moat completion
--
-- Additive, workspace-scoped layers on top of Execution Assurance: policy,
-- approvals, portfolios, dependencies, external evidence, outcome learning,
-- organizational memory, state transitions, and compliance export manifests.

ALTER TABLE public.goal_assurance_evidence
  ADD COLUMN IF NOT EXISTS source_provider TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_workspace_id_id
  ON public.users (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_assurance_evidence_idempotency
  ON public.goal_assurance_evidence (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.assurance_workspace_policies (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  risk_window_days INTEGER NOT NULL DEFAULT 14,
  require_result_evidence BOOLEAN NOT NULL DEFAULT TRUE,
  automatic_external_evidence BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_state_change BOOLEAN NOT NULL DEFAULT TRUE,
  minimum_pattern_sample INTEGER NOT NULL DEFAULT 3,
  approval_matrix JSONB NOT NULL DEFAULT '{"complete":{"requestRoles":["user","manager","admin"],"approveRoles":["manager","admin"]},"recovery":{"requestRoles":["manager","admin"],"approveRoles":["manager","admin"]},"evidence":{"writeRoles":["user","manager","admin"]}}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_policy_risk_window_check CHECK (risk_window_days BETWEEN 1 AND 90),
  CONSTRAINT assurance_policy_pattern_sample_check CHECK (minimum_pattern_sample BETWEEN 3 AND 100)
);

CREATE TABLE IF NOT EXISTS public.assurance_portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  owner_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_portfolio_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT assurance_portfolio_status_check CHECK (status IN ('active', 'completed', 'archived')),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_assurance_portfolios_workspace
  ON public.assurance_portfolios (workspace_id, status, target_date);

CREATE TABLE IF NOT EXISTS public.assurance_portfolio_goals (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL,
  goal_id UUID NOT NULL,
  added_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, portfolio_id, goal_id),
  CONSTRAINT assurance_portfolio_goals_portfolio_fkey
    FOREIGN KEY (workspace_id, portfolio_id)
    REFERENCES public.assurance_portfolios(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_portfolio_goals_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assurance_portfolio_goals_goal
  ON public.assurance_portfolio_goals (workspace_id, goal_id);

CREATE TABLE IF NOT EXISTS public.assurance_goal_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  predecessor_goal_id UUID NOT NULL,
  successor_goal_id UUID NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'blocks',
  note TEXT,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_dependency_predecessor_fkey
    FOREIGN KEY (workspace_id, predecessor_goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_dependency_successor_fkey
    FOREIGN KEY (workspace_id, successor_goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_dependency_not_self CHECK (predecessor_goal_id <> successor_goal_id),
  CONSTRAINT assurance_dependency_type_check CHECK (dependency_type IN ('blocks', 'informs')),
  UNIQUE (workspace_id, predecessor_goal_id, successor_goal_id)
);

CREATE INDEX IF NOT EXISTS idx_assurance_dependencies_successor
  ON public.assurance_goal_dependencies (workspace_id, successor_goal_id);

CREATE TABLE IF NOT EXISTS public.assurance_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decision_note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT assurance_approval_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_approval_action_check CHECK (action_type IN ('complete', 'recovery')),
  CONSTRAINT assurance_approval_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assurance_approval_one_pending
  ON public.assurance_approval_requests (workspace_id, goal_id, action_type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_assurance_approval_inbox
  ON public.assurance_approval_requests (workspace_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_state_snapshots (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  state TEXT NOT NULL,
  explanation TEXT NOT NULL,
  state_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  transition_count INTEGER NOT NULL DEFAULT 0,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, goal_id),
  CONSTRAINT assurance_state_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_state_value_check CHECK (state IN ('insufficient_evidence', 'on_track', 'at_risk', 'off_track', 'needs_evidence', 'verified'))
);

CREATE INDEX IF NOT EXISTS idx_assurance_state_attention
  ON public.assurance_state_snapshots (workspace_id, state, changed_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_outcome_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  target_date DATE,
  verified_at TIMESTAMPTZ NOT NULL,
  on_time BOOLEAN,
  days_to_verify INTEGER,
  pre_completion_state TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  external_evidence_count INTEGER NOT NULL DEFAULT 0,
  recovery_action_count INTEGER NOT NULL DEFAULT 0,
  decision_count INTEGER NOT NULL DEFAULT 0,
  approved_decision_count INTEGER NOT NULL DEFAULT 0,
  average_decision_hours NUMERIC(10,2),
  source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_observation_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, goal_id)
);

ALTER TABLE public.assurance_outcome_observations
  ADD COLUMN IF NOT EXISTS decision_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_decision_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_decision_hours NUMERIC(10,2);

CREATE INDEX IF NOT EXISTS idx_assurance_observations_learning
  ON public.assurance_outcome_observations (workspace_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_memory_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pattern_key TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_label TEXT NOT NULL DEFAULT 'emerging',
  version INTEGER NOT NULL DEFAULT 1,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_memory_sample_check CHECK (sample_size >= 3),
  CONSTRAINT assurance_memory_confidence_check CHECK (confidence_label IN ('emerging', 'established')),
  UNIQUE (workspace_id, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_assurance_memory_workspace
  ON public.assurance_memory_patterns (workspace_id, last_observed_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_export_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  format TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  record_count INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_export_format_check CHECK (format IN ('json', 'csv')),
  CONSTRAINT assurance_export_digest_check CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_assurance_exports_workspace
  ON public.assurance_export_manifests (workspace_id, generated_at DESC);

-- User ids are globally unique today, but composite foreign keys make tenant
-- ownership a database invariant as well as an application check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='goal_assurance_evidence_recorded_by_workspace_fkey') THEN
    ALTER TABLE public.goal_assurance_evidence
      ADD CONSTRAINT goal_assurance_evidence_recorded_by_workspace_fkey
      FOREIGN KEY (workspace_id, recorded_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (recorded_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_policy_updated_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_workspace_policies
      ADD CONSTRAINT assurance_policy_updated_by_workspace_fkey
      FOREIGN KEY (workspace_id, updated_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (updated_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_portfolio_owner_workspace_fkey') THEN
    ALTER TABLE public.assurance_portfolios
      ADD CONSTRAINT assurance_portfolio_owner_workspace_fkey
      FOREIGN KEY (workspace_id, owner_id)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (owner_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_portfolio_created_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_portfolios
      ADD CONSTRAINT assurance_portfolio_created_by_workspace_fkey
      FOREIGN KEY (workspace_id, created_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (created_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_portfolio_goal_added_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_portfolio_goals
      ADD CONSTRAINT assurance_portfolio_goal_added_by_workspace_fkey
      FOREIGN KEY (workspace_id, added_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (added_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_dependency_created_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_goal_dependencies
      ADD CONSTRAINT assurance_dependency_created_by_workspace_fkey
      FOREIGN KEY (workspace_id, created_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (created_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_approval_requested_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_approval_requests
      ADD CONSTRAINT assurance_approval_requested_by_workspace_fkey
      FOREIGN KEY (workspace_id, requested_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (requested_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_approval_decided_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_approval_requests
      ADD CONSTRAINT assurance_approval_decided_by_workspace_fkey
      FOREIGN KEY (workspace_id, decided_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (decided_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_export_requested_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_export_manifests
      ADD CONSTRAINT assurance_export_requested_by_workspace_fkey
      FOREIGN KEY (workspace_id, requested_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (requested_by);
  END IF;
END $$;

ALTER TABLE public.assurance_workspace_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_portfolio_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_goal_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_outcome_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_memory_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_export_manifests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.assurance_outcome_observations IS
  'Verified, workspace-scoped ground truth used for deterministic decision-effectiveness learning.';
COMMENT ON TABLE public.assurance_memory_patterns IS
  'Evidence-backed workspace patterns. Rows exist only after the configured minimum verified sample.';
COMMENT ON TABLE public.assurance_export_manifests IS
  'Tamper-evident manifest for each compliance assurance export; content is delivered to the requesting user.';
