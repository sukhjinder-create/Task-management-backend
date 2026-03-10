CREATE TABLE IF NOT EXISTS git_project_automation_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  project_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  auto_status_enabled BOOLEAN NOT NULL DEFAULT true,
  auto_complete_on_prod BOOLEAN NOT NULL DEFAULT false,
  repo_full_name TEXT NULL,
  environment_sequence JSONB NOT NULL DEFAULT '["dev","qa","stage","uat","prod"]'::jsonb,
  branch_environment_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  require_task_key BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_git_project_automation_settings UNIQUE (workspace_id, project_id),
  CONSTRAINT fk_git_project_automation_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_git_project_automation_workspace_project
  ON git_project_automation_settings(workspace_id, project_id);

CREATE TABLE IF NOT EXISTS git_automation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  delivery_id TEXT NULL,
  repo_full_name TEXT NULL,
  branch_name TEXT NULL,
  commit_count INT NOT NULL DEFAULT 0,
  linked_task_count INT NOT NULL DEFAULT 0,
  applied_task_count INT NOT NULL DEFAULT 0,
  skipped_task_count INT NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_git_automation_events_delivery
  ON git_automation_events(provider, delivery_id)
  WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_git_automation_events_workspace_created
  ON git_automation_events(workspace_id, created_at DESC);
