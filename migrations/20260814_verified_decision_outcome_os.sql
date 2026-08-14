-- Verified Decision-to-Outcome Operating System
--
-- Additive, tenant-enforced records for decision memory, reversible experiments,
-- counterfactual scenario analysis, adaptive-policy proposals, and immutable
-- outcome receipts. Existing goals, tasks, approvals, scores, and assurance
-- records remain authoritative and backward compatible.

ALTER TABLE public.assurance_workspace_policies
  ADD COLUMN IF NOT EXISTS decision_review_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS require_decision_rationale BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assurance_policy_decision_review_days_check'
      AND conrelid = 'public.assurance_workspace_policies'::regclass
  ) THEN
    ALTER TABLE public.assurance_workspace_policies
      ADD CONSTRAINT assurance_policy_decision_review_days_check
      CHECK (decision_review_days BETWEEN 1 AND 180) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.assurance_workspace_policies
  VALIDATE CONSTRAINT assurance_policy_decision_review_days_check;

ALTER TABLE public.assurance_outcome_observations
  ADD COLUMN IF NOT EXISTS explicit_decision_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewed_decision_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS experiment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_experiment_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.assurance_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  decision_type TEXT NOT NULL DEFAULT 'execution',
  question TEXT NOT NULL,
  selected_option TEXT NOT NULL,
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
  rationale TEXT NOT NULL,
  expected_effect TEXT,
  confidence SMALLINT,
  reversibility TEXT NOT NULL DEFAULT 'reversible',
  status TEXT NOT NULL DEFAULT 'decided',
  recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_due_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_decision_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_decision_type_check
    CHECK (decision_type IN ('execution', 'scope', 'capacity', 'risk', 'evidence', 'experiment', 'policy', 'other')),
  CONSTRAINT assurance_decision_confidence_check
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  CONSTRAINT assurance_decision_reversibility_check
    CHECK (reversibility IN ('reversible', 'partially_reversible', 'irreversible')),
  CONSTRAINT assurance_decision_status_check
    CHECK (status IN ('decided', 'superseded')),
  CONSTRAINT assurance_decision_alternatives_check
    CHECK (jsonb_typeof(alternatives) = 'array'),
  CONSTRAINT assurance_decision_question_check
    CHECK (char_length(btrim(question)) BETWEEN 1 AND 1000),
  CONSTRAINT assurance_decision_option_check
    CHECK (char_length(btrim(selected_option)) BETWEEN 1 AND 1000),
  CONSTRAINT assurance_decision_rationale_check
    CHECK (char_length(btrim(rationale)) BETWEEN 1 AND 4000),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_assurance_decisions_goal
  ON public.assurance_decisions (workspace_id, goal_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_assurance_decisions_review_due
  ON public.assurance_decisions (workspace_id, review_due_at, decided_at)
  WHERE status = 'decided' AND review_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.assurance_decision_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL,
  effectiveness TEXT NOT NULL,
  observed_result TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_decision_review_decision_fkey
    FOREIGN KEY (workspace_id, decision_id)
    REFERENCES public.assurance_decisions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_decision_review_effectiveness_check
    CHECK (effectiveness IN ('effective', 'mixed', 'ineffective', 'inconclusive')),
  CONSTRAINT assurance_decision_review_result_check
    CHECK (char_length(btrim(observed_result)) BETWEEN 1 AND 4000),
  CONSTRAINT assurance_decision_review_evidence_check
    CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_assurance_decision_reviews_decision
  ON public.assurance_decision_reviews (workspace_id, decision_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  smallest_test TEXT NOT NULL,
  success_measure TEXT NOT NULL,
  expected_information TEXT,
  owner_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'planned',
  result_status TEXT NOT NULL DEFAULT 'not_recorded',
  observed_result TEXT,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_experiment_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_experiment_status_check
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  CONSTRAINT assurance_experiment_result_status_check
    CHECK (result_status IN ('not_recorded', 'supported', 'refuted', 'inconclusive')),
  CONSTRAINT assurance_experiment_evidence_check
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT assurance_experiment_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_assurance_experiments_goal
  ON public.assurance_experiments (workspace_id, goal_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_assurance_experiments_owner
  ON public.assurance_experiments (workspace_id, owner_id, status, due_date);

CREATE TABLE IF NOT EXISTS public.assurance_scenario_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  name TEXT NOT NULL,
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  evidence_status TEXT NOT NULL,
  confidence_label TEXT NOT NULL,
  model_version TEXT NOT NULL DEFAULT 'decision_scenario_v1',
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_scenario_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_scenario_evidence_status_check
    CHECK (evidence_status IN ('insufficient_evidence', 'modeled')),
  CONSTRAINT assurance_scenario_confidence_check
    CHECK (confidence_label IN ('none', 'low', 'medium', 'high')),
  CONSTRAINT assurance_scenario_input_check CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT assurance_scenario_result_check CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_assurance_scenarios_goal
  ON public.assurance_scenario_analyses (workspace_id, goal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_policy_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  policy_key TEXT NOT NULL,
  current_value JSONB NOT NULL,
  proposed_value JSONB NOT NULL,
  rationale TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_size INTEGER NOT NULL DEFAULT 0,
  confounded BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'candidate',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  CONSTRAINT assurance_policy_proposal_key_check
    CHECK (policy_key IN ('risk_window_days')),
  CONSTRAINT assurance_policy_proposal_status_check
    CHECK (status IN ('candidate', 'approved', 'rejected', 'applied', 'blocked')),
  CONSTRAINT assurance_policy_proposal_sample_check CHECK (sample_size >= 0),
  CONSTRAINT assurance_policy_proposal_evidence_check CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assurance_policy_one_candidate
  ON public.assurance_policy_proposals (workspace_id, policy_key)
  WHERE status = 'candidate';
CREATE INDEX IF NOT EXISTS idx_assurance_policy_proposals_workspace
  ON public.assurance_policy_proposals (workspace_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS public.assurance_outcome_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  snapshot JSONB NOT NULL,
  sha256 TEXT NOT NULL,
  redaction JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_receipt_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_receipt_digest_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT assurance_receipt_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object'),
  UNIQUE (workspace_id, goal_id, version)
);

CREATE INDEX IF NOT EXISTS idx_assurance_receipts_goal
  ON public.assurance_outcome_receipts (workspace_id, goal_id, generated_at DESC);

-- Composite user references make workspace ownership a database invariant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_decision_recorded_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_decisions
      ADD CONSTRAINT assurance_decision_recorded_by_workspace_fkey
      FOREIGN KEY (workspace_id, recorded_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (recorded_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_decision_reviewed_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_decision_reviews
      ADD CONSTRAINT assurance_decision_reviewed_by_workspace_fkey
      FOREIGN KEY (workspace_id, reviewed_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (reviewed_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_experiment_owner_workspace_fkey') THEN
    ALTER TABLE public.assurance_experiments
      ADD CONSTRAINT assurance_experiment_owner_workspace_fkey
      FOREIGN KEY (workspace_id, owner_id)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (owner_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_experiment_created_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_experiments
      ADD CONSTRAINT assurance_experiment_created_by_workspace_fkey
      FOREIGN KEY (workspace_id, created_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (created_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_scenario_created_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_scenario_analyses
      ADD CONSTRAINT assurance_scenario_created_by_workspace_fkey
      FOREIGN KEY (workspace_id, created_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (created_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_policy_proposal_reviewed_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_policy_proposals
      ADD CONSTRAINT assurance_policy_proposal_reviewed_by_workspace_fkey
      FOREIGN KEY (workspace_id, reviewed_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (reviewed_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_receipt_requested_by_workspace_fkey') THEN
    ALTER TABLE public.assurance_outcome_receipts
      ADD CONSTRAINT assurance_receipt_requested_by_workspace_fkey
      FOREIGN KEY (workspace_id, requested_by)
      REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (requested_by);
  END IF;
END $$;

ALTER TABLE public.assurance_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_decision_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_scenario_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_policy_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assurance_outcome_receipts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.assurance_decisions IS
  'Workspace-scoped decision memory recording what was chosen, why, expected effect, confidence, and reversibility.';
COMMENT ON TABLE public.assurance_decision_reviews IS
  'Append-only observed results used to measure decision and intervention effectiveness without causal overclaiming.';
COMMENT ON TABLE public.assurance_experiments IS
  'Small reversible tests attached to governed outcomes; results remain distinct from verified outcome evidence.';
COMMENT ON TABLE public.assurance_scenario_analyses IS
  'Immutable evidence-bounded counterfactual decision-support runs. These are not canonical workspace scores.';
COMMENT ON TABLE public.assurance_policy_proposals IS
  'Evidence-backed governance proposals. No proposal changes policy without an explicit workspace-admin decision.';
COMMENT ON TABLE public.assurance_outcome_receipts IS
  'Immutable, tamper-evident snapshots of one outcome and its supporting decision-to-evidence lineage.';
