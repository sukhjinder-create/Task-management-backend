-- ============================================================================
--  AI PLATFORM — P4: Capability CONFIGURATION table (contract vs config split)
--  Additive & idempotent. The immutable capability CONTRACT lives in code
--  (ai-platform/capabilities/registry.js). This table holds the MUTABLE,
--  DB-owned, per-scope CONFIGURATION (routing/enable/lock) — the other half of
--  the split (Contract v2 §4). Until rows exist, code + ai_capabilities defaults
--  apply, so applying this changes no behavior. NOT executed by this phase.
--
--  Rollback: DROP TABLE IF EXISTS ai_capability_config;
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_capability_config (
  id             BIGSERIAL PRIMARY KEY,
  capability_key TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'PLATFORM',        -- 'PLATFORM' | workspace_id
  workspace_id   TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  provider       TEXT,
  model          TEXT,
  prompt_key     TEXT,
  runtime_profile TEXT,
  policy_set     TEXT,
  key_ownership  TEXT,
  failover_json  JSONB,
  lock_level     TEXT NOT NULL DEFAULT 'workspace_customizable'
                   CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  created_by     TEXT,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (capability_key, scope, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_capability_config_lookup
  ON ai_capability_config (capability_key, scope, workspace_id);
