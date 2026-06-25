-- Enterprise Intelligence Workspace Scoring Configuration
-- Adds canonical workspace-admin controlled scoring weightages.

CREATE TABLE IF NOT EXISTS enterprise_intelligence_scoring_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_version TEXT NOT NULL DEFAULT 'enterprise-scoring-weights-v1',
  updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_enterprise_intelligence_scoring_configs_workspace
  ON enterprise_intelligence_scoring_configs(workspace_id, updated_at DESC);

CREATE OR REPLACE FUNCTION touch_enterprise_intelligence_scoring_configs()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enterprise_intelligence_scoring_configs_touch
  ON enterprise_intelligence_scoring_configs;

CREATE TRIGGER trg_enterprise_intelligence_scoring_configs_touch
BEFORE UPDATE ON enterprise_intelligence_scoring_configs
FOR EACH ROW
EXECUTE FUNCTION touch_enterprise_intelligence_scoring_configs();
