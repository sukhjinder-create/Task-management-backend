CREATE TABLE IF NOT EXISTS testing_agent_project_profiles (
  workspace_id UUID NOT NULL,
  project_id UUID NOT NULL,
  repo_path TEXT NULL,
  framework TEXT NULL,
  commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, project_id),
  CONSTRAINT fk_testing_profile_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_testing_agent_project_profiles_workspace
  ON testing_agent_project_profiles(workspace_id, project_id);
