-- Migration imports tracking table
-- Stores every import run (Slack / Asana / YouTrack) per workspace
-- Metadata column stores what was created, used for deletion

CREATE TABLE IF NOT EXISTS migration_imports (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID          NOT NULL,
  source        VARCHAR(50)   NOT NULL,          -- 'slack' | 'asana' | 'youtrack'
  import_number INTEGER       NOT NULL,          -- 1, 2, 3 … per workspace+source
  status        VARCHAR(20)   NOT NULL DEFAULT 'completed',
  stats         JSONB         NOT NULL DEFAULT '{}',
  metadata      JSONB         NOT NULL DEFAULT '{}', -- IDs created — used for rollback/delete
  triggered_by  UUID,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  UNIQUE (workspace_id, source, import_number)
);

CREATE INDEX IF NOT EXISTS idx_migration_imports_workspace
  ON migration_imports (workspace_id, source, created_at DESC);
