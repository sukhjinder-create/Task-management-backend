-- Enterprise Intelligence Re-architecture
-- Shadow-mode compatible: creates authoritative intelligence repositories
-- without dropping legacy monthly scoring tables.

CREATE TABLE IF NOT EXISTS user_intelligence (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band TEXT NOT NULL,
  trend TEXT NOT NULL DEFAULT 'stable',
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  attendance JSONB NOT NULL DEFAULT '{}'::jsonb,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  concerns JSONB NOT NULL DEFAULT '[]'::jsonb,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
  indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk JSONB NOT NULL DEFAULT '{}'::jsonb,
  analytics JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash TEXT,
  calculation_version TEXT NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_intelligence (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band TEXT NOT NULL,
  trend TEXT NOT NULL DEFAULT 'stable',
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
  indexes JSONB NOT NULL DEFAULT '{}'::jsonb,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  concerns JSONB NOT NULL DEFAULT '[]'::jsonb,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
  indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk JSONB NOT NULL DEFAULT '{}'::jsonb,
  analytics JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash TEXT,
  calculation_version TEXT NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS team_intelligence (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL,
  manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band TEXT NOT NULL,
  trend TEXT NOT NULL DEFAULT 'stable',
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
  indexes JSONB NOT NULL DEFAULT '{}'::jsonb,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  concerns JSONB NOT NULL DEFAULT '[]'::jsonb,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
  indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk JSONB NOT NULL DEFAULT '{}'::jsonb,
  analytics JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash TEXT,
  calculation_version TEXT NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, team_key)
);

CREATE TABLE IF NOT EXISTS workspace_intelligence (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band TEXT NOT NULL,
  trend TEXT NOT NULL DEFAULT 'stable',
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
  indexes JSONB NOT NULL DEFAULT '{}'::jsonb,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  concerns JSONB NOT NULL DEFAULT '[]'::jsonb,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
  indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk JSONB NOT NULL DEFAULT '{}'::jsonb,
  analytics JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_window JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash TEXT,
  calculation_version TEXT NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);

CREATE TABLE IF NOT EXISTS intelligence_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'team', 'project', 'workspace')),
  subject_key TEXT NOT NULL,
  period_key TEXT NOT NULL,
  captured_for_date DATE NOT NULL DEFAULT CURRENT_DATE,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band TEXT NOT NULL,
  trend TEXT NOT NULL DEFAULT 'stable',
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculation_version TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, scope_type, subject_key, period_key, captured_for_date)
);

CREATE TABLE IF NOT EXISTS intelligence_recalculation_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  user_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  project_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  team_keys TEXT[] NOT NULL DEFAULT '{}'::text[],
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_intelligence_workspace_score
  ON user_intelligence(workspace_id, score DESC, last_evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_intelligence_workspace_score
  ON project_intelligence(workspace_id, score DESC, last_evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_intelligence_workspace_score
  ON team_intelligence(workspace_id, score DESC, last_evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_snapshots_lookup
  ON intelligence_snapshots(workspace_id, scope_type, subject_key, period_key, captured_for_date DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_recalc_workspace_created
  ON intelligence_recalculation_events(workspace_id, created_at DESC);
