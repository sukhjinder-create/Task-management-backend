-- Operations OS foundation
-- Additive tables for command centers, digests, AI approvals, automations, and workspace memory

CREATE TABLE IF NOT EXISTS workspace_memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'workspace', -- workspace | private
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  source_entity_type TEXT,
  source_entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_entries_scope
  ON workspace_memory_entries(workspace_id, visibility, is_archived, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_entries_tags
  ON workspace_memory_entries USING gin(tags);

CREATE TABLE IF NOT EXISTS operations_ai_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'operations',
  role_scope TEXT NOT NULL DEFAULT 'workspace',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  explanation TEXT,
  confidence NUMERIC(4,3),
  risk_level TEXT NOT NULL DEFAULT 'medium',
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed
  generated_by TEXT NOT NULL DEFAULT 'system',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operations_ai_actions_workspace_status
  ON operations_ai_actions(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_ai_actions_target_user
  ON operations_ai_actions(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operations_ai_action_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES operations_ai_actions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision TEXT NOT NULL, -- approved | rejected | executed
  notes TEXT,
  decision_by UUID REFERENCES users(id) ON DELETE SET NULL,
  outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operations_ai_action_decisions_action
  ON operations_ai_action_decisions(action_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_digest_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  frequency TEXT NOT NULL DEFAULT 'daily', -- daily | manual
  delivery_hour SMALLINT NOT NULL DEFAULT 8,
  channel TEXT NOT NULL DEFAULT 'in_app', -- in_app | email
  include_sections JSONB NOT NULL DEFAULT '["priorities","people","approvals","risks"]'::jsonb,
  last_sent_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_digest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_scope TEXT NOT NULL,
  digest_type TEXT NOT NULL DEFAULT 'daily_os',
  delivery_mode TEXT NOT NULL DEFAULT 'preview', -- preview | manual | scheduled
  summary TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'generated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_digest_runs_workspace_user
  ON workspace_digest_runs(workspace_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operations_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mode TEXT NOT NULL DEFAULT 'assist', -- assist | auto
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_operations_automation_rules_workspace
  ON operations_automation_rules(workspace_id, enabled);
