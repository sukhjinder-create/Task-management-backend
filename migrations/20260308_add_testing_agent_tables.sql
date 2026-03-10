CREATE TABLE IF NOT EXISTS testing_agent_settings (
  workspace_id UUID PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  auto_generate_on_git BOOLEAN NOT NULL DEFAULT TRUE,
  auto_run_on_git BOOLEAN NOT NULL DEFAULT FALSE,
  max_runtime_seconds INT NOT NULL DEFAULT 900,
  test_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS testing_agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  trigger_source TEXT NOT NULL DEFAULT 'manual',
  mode TEXT NOT NULL DEFAULT 'run',
  status TEXT NOT NULL DEFAULT 'pending',
  generated_cases JSONB NOT NULL DEFAULT '[]'::jsonb,
  commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_testing_runs_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_testing_agent_runs_workspace_created
  ON testing_agent_runs(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_testing_agent_runs_workspace_task
  ON testing_agent_runs(workspace_id, task_id, created_at DESC);
