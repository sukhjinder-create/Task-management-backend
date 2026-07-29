-- ============================================================================
--  Platform feature enablement per workspace — so a superadmin can turn the
--  Execution Platform / Enterprise Intelligence ON for a workspace from the UI
--  (instead of an env-only canary list). Additive & idempotent.
--  Rollback: DROP TABLE IF EXISTS platform_workspace_features;
-- ============================================================================
CREATE TABLE IF NOT EXISTS platform_workspace_features (
  workspace_id TEXT NOT NULL,
  feature      TEXT NOT NULL,            -- 'execution' | 'intelligence'
  enabled      BOOLEAN NOT NULL DEFAULT false,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, feature)
);
CREATE INDEX IF NOT EXISTS idx_platform_features_enabled ON platform_workspace_features (feature) WHERE enabled = true;
