BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_key TEXT,
  ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_workspace_source
  ON tasks (workspace_id, source_type, source_key)
  WHERE source_type IS NOT NULL AND source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_huddle_source
  ON tasks (workspace_id, ((source_metadata->>'sessionId')))
  WHERE source_type = 'huddle_action_item';

CREATE TABLE IF NOT EXISTS huddle_memory_candidate_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  memory_candidate_id UUID NOT NULL REFERENCES huddle_memory_candidates(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  candidate_text TEXT NOT NULL,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  change_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (memory_candidate_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_huddle_memory_candidate_revisions_lookup
  ON huddle_memory_candidate_revisions (
    workspace_id,
    session_id,
    memory_candidate_id,
    revision_number DESC
  );

CREATE TABLE IF NOT EXISTS huddle_copilot_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider TEXT,
  model TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_huddle_copilot_queries_session
  ON huddle_copilot_queries (workspace_id, session_id, created_at DESC);

COMMIT;
