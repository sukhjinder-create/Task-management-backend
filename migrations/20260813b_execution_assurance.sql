-- Enterprise Execution Assurance
--
-- Extends the existing Goals model instead of introducing a competing work
-- object. A goal becomes an outcome commitment when it has a success measure,
-- target date, owner, and (optionally) a primary project. Evidence is append-only
-- and workspace scoped. Existing goals and every existing goal flow remain valid.

ALTER TABLE public.okr_objectives
  ADD COLUMN IF NOT EXISTS success_measure TEXT,
  ADD COLUMN IF NOT EXISTS target_date DATE,
  ADD COLUMN IF NOT EXISTS primary_project_id UUID,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS evidence_requirements JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Composite tenant keys make cross-workspace references impossible even if a
-- future application path omits its workspace predicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_id_id
  ON public.projects (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_okr_objectives_workspace_id_id
  ON public.okr_objectives (workspace_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'okr_objectives_primary_project_workspace_fkey'
      AND conrelid = 'public.okr_objectives'::regclass
  ) THEN
    ALTER TABLE public.okr_objectives
      ADD CONSTRAINT okr_objectives_primary_project_workspace_fkey
      FOREIGN KEY (workspace_id, primary_project_id)
      REFERENCES public.projects(workspace_id, id) ON DELETE SET NULL (primary_project_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'okr_objectives_priority_check'
      AND conrelid = 'public.okr_objectives'::regclass
  ) THEN
    ALTER TABLE public.okr_objectives
      ADD CONSTRAINT okr_objectives_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'critical')) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.okr_objectives
  VALIDATE CONSTRAINT okr_objectives_priority_check;

CREATE INDEX IF NOT EXISTS idx_okr_objectives_assurance
  ON public.okr_objectives (workspace_id, target_date, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_okr_objectives_primary_project
  ON public.okr_objectives (workspace_id, primary_project_id)
  WHERE primary_project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.goal_assurance_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  evidence_type TEXT NOT NULL DEFAULT 'result',
  label TEXT NOT NULL,
  note TEXT,
  source_entity_type TEXT,
  source_entity_id TEXT,
  recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT goal_assurance_evidence_type_check
    CHECK (evidence_type IN ('result', 'milestone', 'document', 'task', 'project', 'integration', 'correction')),
  CONSTRAINT goal_assurance_evidence_label_check
    CHECK (char_length(btrim(label)) BETWEEN 1 AND 500),
  CONSTRAINT goal_assurance_evidence_workspace_goal_fkey
    FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_assurance_evidence_workspace_goal
  ON public.goal_assurance_evidence (workspace_id, goal_id, recorded_at DESC);

ALTER TABLE public.goal_assurance_evidence ENABLE ROW LEVEL SECURITY;

-- Existing governed operations actions become the decision/audit trail for a
-- commitment. This is additive and nullable so older automation is untouched.
ALTER TABLE public.operations_ai_actions
  ADD COLUMN IF NOT EXISTS goal_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operations_ai_actions_goal_workspace_fkey'
      AND conrelid = 'public.operations_ai_actions'::regclass
  ) THEN
    ALTER TABLE public.operations_ai_actions
      ADD CONSTRAINT operations_ai_actions_goal_workspace_fkey
      FOREIGN KEY (workspace_id, goal_id)
      REFERENCES public.okr_objectives(workspace_id, id) ON DELETE SET NULL (goal_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operations_ai_actions_workspace_goal
  ON public.operations_ai_actions (workspace_id, goal_id, status, created_at DESC)
  WHERE goal_id IS NOT NULL;

COMMENT ON TABLE public.goal_assurance_evidence IS
  'Append-only, workspace-scoped evidence used to verify strategic outcomes.';
COMMENT ON COLUMN public.okr_objectives.success_measure IS
  'Plain-language definition of how the outcome will be recognized as complete.';
COMMENT ON COLUMN public.okr_objectives.evidence_requirements IS
  'Optional evidence labels. Empty means the owner may provide a result record at completion.';
