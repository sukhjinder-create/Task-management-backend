-- ============================================================================
--  AI PLATFORM — Foundation schema (Phase 1)
--  Additive & idempotent. Creates the governance/config/observability tables
--  the centralized AI Platform reads. It does NOT modify or drop any existing
--  table, so applying it is regression-safe. Rollback = DROP these tables
--  (see the bottom of this file) — the app degrades cleanly to env defaults.
--
--  Lock model (enterprise inheritance) on every configurable object:
--    global_locked          → platform value wins; workspace override ignored
--    workspace_customizable → workspace may override platform default
--    workspace_locked       → a specific workspace is pinned by the platform
-- ============================================================================

-- ── Providers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_providers (
  id             BIGSERIAL PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,                 -- openai, groq, anthropic, gemini, ollama, azure, ...
  display_name   TEXT NOT NULL,
  adapter        TEXT NOT NULL,                        -- openai_compatible | ollama | anthropic | gemini | huggingface | bedrock
  base_url       TEXT,
  api_key_env    TEXT,                                 -- name of the env var holding the key (never the key itself)
  default_model  TEXT,
  timeout_ms     INTEGER,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  lock_level     TEXT NOT NULL DEFAULT 'workspace_customizable'
                   CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  config_json    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- adapter extras (apiVersion, headers, region, ...)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Models ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_models (
  id                   BIGSERIAL PRIMARY KEY,
  provider_key         TEXT NOT NULL,
  model_key            TEXT NOT NULL,
  display_name         TEXT,
  context_window       INTEGER,
  input_cost_per_1k    NUMERIC(12,6),
  output_cost_per_1k   NUMERIC(12,6),
  enabled              BOOLEAN NOT NULL DEFAULT true,
  lock_level           TEXT NOT NULL DEFAULT 'workspace_customizable'
                         CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_key, model_key)
);

-- ── Runtime Profiles ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_runtime_profiles (
  id           BIGSERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,                   -- balanced, creative, analytical, custom-xxx
  display_name TEXT NOT NULL,
  description  TEXT,
  params_json  JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {temperature, topP, topK, maxTokens, json, retries, timeoutMs}
  is_system    BOOLEAN NOT NULL DEFAULT false,
  lock_level   TEXT NOT NULL DEFAULT 'workspace_customizable'
                 CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Prompts (first-class objects) + versions ────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_prompts (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  category      TEXT,
  description   TEXT,
  feature       TEXT,                                  -- capability key it serves
  variables_json JSONB NOT NULL DEFAULT '[]'::jsonb,   -- declared template variables
  owner         TEXT,
  created_by    TEXT,
  updated_by    TEXT,
  lock_level    TEXT NOT NULL DEFAULT 'workspace_customizable'
                  CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id           BIGSERIAL PRIMARY KEY,
  prompt_id    BIGINT NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','testing','published','archived')),
  notes        TEXT,
  created_by   TEXT,
  approved_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (prompt_id, version)
);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_versions_lookup
  ON ai_prompt_versions (prompt_id, status, version DESC);

-- ── Capabilities (the AI feature registry) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_capabilities (
  id                  BIGSERIAL PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  description         TEXT,
  category            TEXT,
  owner               TEXT,
  default_provider_key TEXT,
  default_model_key    TEXT,
  default_profile_key  TEXT,
  default_prompt_key   TEXT,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  lock_level          TEXT NOT NULL DEFAULT 'workspace_customizable'
                        CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Workspace overrides (the inheritance leaf) ──────────────────────────────
CREATE TABLE IF NOT EXISTS ai_workspace_overrides (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object_type  TEXT NOT NULL
                 CHECK (object_type IN ('provider','model','prompt','profile','capability_routing','policy')),
  object_key   TEXT NOT NULL,                          -- capability key / prompt key / provider key ...
  value_json   JSONB NOT NULL DEFAULT '{}'::jsonb,     -- e.g. { provider, model, profile, prompt_key } or { body }
  lock_level   TEXT NOT NULL DEFAULT 'workspace_customizable'
                 CHECK (lock_level IN ('global_locked','workspace_customizable','workspace_locked')),
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, object_type, object_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_ws_overrides_ws ON ai_workspace_overrides (workspace_id);

-- ── Policies & budgets ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_policies (
  id           BIGSERIAL PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','workspace')),
  workspace_id TEXT,
  key          TEXT NOT NULL,                          -- allowed_providers, blocked_providers, allowed_models, ...
  value_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_policies_scope ON ai_policies (scope, workspace_id, enabled);

CREATE TABLE IF NOT EXISTS ai_budgets (
  id             BIGSERIAL PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'workspace' CHECK (scope IN ('global','workspace')),
  workspace_id   TEXT,
  period         TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('daily','monthly')),
  limit_cost_usd NUMERIC(12,4),
  limit_tokens   BIGINT,
  hard_limit     BOOLEAN NOT NULL DEFAULT false,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Observability ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_request_logs (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id   TEXT,
  capability_key TEXT,
  provider_key   TEXT,
  model_key      TEXT,
  prompt_key     TEXT,
  prompt_version INTEGER,
  profile_key    TEXT,
  latency_ms     INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  est_cost_usd   NUMERIC(12,6),
  status         TEXT,                                 -- success | failure | blocked
  failure_reason TEXT,
  retries        INTEGER DEFAULT 0,
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_req_logs_ws_ts ON ai_request_logs (workspace_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ai_req_logs_cap_ts ON ai_request_logs (capability_key, ts DESC);

-- ── Audit (config changes / approvals) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type   TEXT,                                   -- superadmin | workspace_admin | system
  actor_id     TEXT,
  action       TEXT,                                   -- create | update | publish | rollback | lock | unlock
  object_type  TEXT,
  object_key   TEXT,
  workspace_id TEXT,
  before_json  JSONB,
  after_json   JSONB
);
CREATE INDEX IF NOT EXISTS idx_ai_audit_ts ON ai_audit_logs (ts DESC);

-- ── Seed the 7 system runtime profiles (idempotent) ─────────────────────────
INSERT INTO ai_runtime_profiles (key, display_name, description, params_json, is_system, lock_level) VALUES
  ('balanced','Balanced','General-purpose default (matches legacy behavior).','{"temperature":0.4,"topP":0.9,"topK":20,"maxTokens":900,"retries":2}', true, 'workspace_customizable'),
  ('creative','Creative','Higher variety for drafting and ideation.','{"temperature":0.9,"topP":0.95,"topK":40,"maxTokens":1200,"retries":2}', true, 'workspace_customizable'),
  ('analytical','Analytical','Lower temperature for structured reasoning.','{"temperature":0.2,"topP":0.85,"topK":20,"maxTokens":1200,"retries":2}', true, 'workspace_customizable'),
  ('deterministic','Deterministic','Near-zero randomness for reproducible output.','{"temperature":0.0,"topP":0.1,"topK":1,"maxTokens":900,"retries":2}', true, 'workspace_customizable'),
  ('fast','Fast','Short, low-latency responses.','{"temperature":0.3,"topP":0.9,"topK":20,"maxTokens":400,"retries":1}', true, 'workspace_customizable'),
  ('low_cost','Low Cost','Minimal tokens to reduce spend.','{"temperature":0.3,"topP":0.9,"topK":20,"maxTokens":350,"retries":1}', true, 'workspace_customizable'),
  ('high_quality','High Quality','Larger budget for the best output.','{"temperature":0.5,"topP":0.95,"topK":40,"maxTokens":2000,"retries":3}', true, 'workspace_customizable')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
--  ROLLBACK (run manually to fully remove Phase 1):
--    DROP TABLE IF EXISTS ai_audit_logs, ai_request_logs, ai_budgets, ai_policies,
--      ai_workspace_overrides, ai_capabilities, ai_prompt_versions, ai_prompts,
--      ai_runtime_profiles, ai_models, ai_providers CASCADE;
--  With the feature flag OFF, dropping these has no effect on the running app.
-- ============================================================================
