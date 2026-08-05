-- ============================================================================
--  AI PLATFORM — P8: Key ownership (Contract v2 §10)
--  Additive & idempotent. Records WHO supplies the key (platform vs workspace
--  BYO), WHO pays, and a KeyRef (a REFERENCE into a secret manager — never the
--  secret value). Until rows exist, the code default (platform-managed, env keys)
--  applies, which matches today's behavior. NOT executed by this phase.
--
--  SECURITY: this table stores key_ref_manager + key_ref only. It MUST NEVER
--  store a raw secret. Secrets are resolved solely inside adapters via KeyRef.
--
--  Rollback: DROP TABLE IF EXISTS ai_key_ownership;
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_key_ownership (
  id               BIGSERIAL PRIMARY KEY,
  scope            TEXT NOT NULL DEFAULT 'PLATFORM',   -- 'PLATFORM' | workspace_id
  workspace_id     TEXT,
  provider         TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'platform_managed'
                     CHECK (mode IN ('platform_managed','workspace_byo')),
  key_ref_manager  TEXT NOT NULL DEFAULT 'env'
                     CHECK (key_ref_manager IN ('env','aws_secrets','gcp_secret_manager','vault','kms')),
  key_ref          TEXT,                                -- reference/name ONLY, never a secret
  key_ref_version  TEXT,
  billing_owner    TEXT NOT NULL DEFAULT 'platform'
                     CHECK (billing_owner IN ('platform','workspace')),
  cost_owner       TEXT NOT NULL DEFAULT 'PLATFORM',
  rotation_policy  TEXT,
  rotation_interval_days INTEGER,
  last_rotated_at  TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','disabled','expired','invalid')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, workspace_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_ai_key_ownership_lookup ON ai_key_ownership (provider, scope, workspace_id);

-- Supabase exposes every table over its public REST API, so RLS is what stops an
-- anon/authenticated key reading this directly, bypassing the backend and its
-- permission checks. Enabled here, in the migration that creates the table,
-- rather than in a later sweep: 20260430_enable_rls_all_tables.sql listed tables
-- by name, so every table created after it silently arrived unprotected -- 85 of
-- them by 2026-08-05. Protecting the table where it is born is what stops that
-- recurring. The backend is unaffected; it connects as the owner, and owners
-- bypass RLS unless FORCE is set (it is not).
ALTER TABLE public.ai_key_ownership ENABLE ROW LEVEL SECURITY;
