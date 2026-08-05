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

-- Supabase exposes every table over its public REST API, so RLS is what stops an
-- anon/authenticated key reading this directly, bypassing the backend and its
-- permission checks. Enabled here, in the migration that creates the table,
-- rather than in a later sweep: 20260430_enable_rls_all_tables.sql listed tables
-- by name, so every table created after it silently arrived unprotected -- 85 of
-- them by 2026-08-05. Protecting the table where it is born is what stops that
-- recurring. The backend is unaffected; it connects as the owner, and owners
-- bypass RLS unless FORCE is set (it is not).
ALTER TABLE public.ai_capability_config ENABLE ROW LEVEL SECURITY;
