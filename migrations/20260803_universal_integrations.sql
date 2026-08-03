-- Universal integrations: event-driven sync + admin-defined providers.
--
-- Three concerns, three tables:
--   1. integration_sync_config   — per-integration sync behaviour (how often to
--      reconcile, which projects are in scope). Previously every connected
--      integration was polled in full every 60s with no way to scope or tune it.
--   2. custom_integration_providers — platforms an admin defines in the UI
--      (base URL + auth + field mapping) without any code change.
--   3. integration_webhook_endpoints — per-endpoint inbound webhook secrets so
--      custom providers get the same real-time path the built-ins have.
--
-- Idempotent: safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-integration sync configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_sync_config (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider                    varchar(64) NOT NULL,

  -- 'webhook'  → real-time via provider webhooks, reconciliation as a safety net
  -- 'poll'     → provider has no webhook support; poll on an interval
  -- 'manual'   → only sync when a human clicks sync
  -- 'disabled' → no background activity at all
  sync_mode                   varchar(24) NOT NULL DEFAULT 'webhook',

  -- Safety net for missed/dropped webhook deliveries. Webhooks are best-effort:
  -- providers have outages, deliveries fail, and Asana silently deactivates
  -- webhooks after repeated failures — without reconciliation a single missed
  -- event means permanent, invisible drift. Default daily; admin-configurable.
  reconcile_interval_minutes  integer NOT NULL DEFAULT 1440,

  -- Empty array = every project the credential can see (previous behaviour).
  -- Non-empty = only these external project ids participate in sync/webhooks.
  scoped_project_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,

  last_reconciled_at          timestamptz,
  next_reconcile_at           timestamptz,
  last_event_at               timestamptz,   -- last inbound webhook
  last_error                  text,
  last_error_at               timestamptz,
  consecutive_failures        integer NOT NULL DEFAULT 0,

  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT integration_sync_config_unique UNIQUE (workspace_id, provider),
  CONSTRAINT integration_sync_config_mode_check
    CHECK (sync_mode IN ('webhook', 'poll', 'manual', 'disabled')),
  -- 5 minutes floor stops an admin from accidentally recreating the old
  -- hammer-the-API behaviour; 30 days ceiling keeps drift bounded.
  CONSTRAINT integration_sync_config_interval_check
    CHECK (reconcile_interval_minutes BETWEEN 5 AND 43200)
);

-- The reconciliation sweep's hot query: "what is due?"
CREATE INDEX IF NOT EXISTS idx_integration_sync_config_due
  ON integration_sync_config (next_reconcile_at)
  WHERE sync_mode IN ('webhook', 'poll');

CREATE INDEX IF NOT EXISTS idx_integration_sync_config_workspace
  ON integration_sync_config (workspace_id);

-- ---------------------------------------------------------------------------
-- 2. Admin-defined ("custom") providers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_integration_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- URL-safe slug used as the `provider` string everywhere else
  -- (workspace_integrations.provider, integration_task_mappings.provider, ...).
  -- Prefixed 'custom:' by the application to guarantee it can never collide
  -- with a built-in provider name.
  provider_key      varchar(96) NOT NULL,
  name              varchar(128) NOT NULL,
  description       text,

  base_url          text NOT NULL,

  -- bearer | header | basic | query | none
  auth_type         varchar(32) NOT NULL DEFAULT 'bearer',
  -- Shape depends on auth_type, e.g. { "token": "..." } / { "header": "X-Api-Key", "value": "..." }
  auth_config       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- How to reach the data, e.g.
  -- { "projects": { "path": "/rest/projects", "itemsPath": "", "idField": "id", "nameField": "name" },
  --   "tasks":    { "path": "/rest/issues?project={projectId}", "itemsPath": "issues" } }
  endpoints         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- External field path -> Asystence field, e.g. { "title": "summary", "status": "state.name" }
  field_mappings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- External value -> Asystence enum, e.g. { "status": { "Done": "completed" } }
  value_mappings    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- draft = still being configured, not usable for import yet
  status            varchar(24) NOT NULL DEFAULT 'draft',

  last_tested_at    timestamptz,
  last_test_ok      boolean,
  last_test_message text,

  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT custom_integration_providers_unique UNIQUE (workspace_id, provider_key),
  CONSTRAINT custom_integration_providers_status_check
    CHECK (status IN ('draft', 'active', 'disabled')),
  CONSTRAINT custom_integration_providers_auth_check
    CHECK (auth_type IN ('bearer', 'header', 'basic', 'query', 'none'))
);

CREATE INDEX IF NOT EXISTS idx_custom_providers_workspace
  ON custom_integration_providers (workspace_id, status);

-- ---------------------------------------------------------------------------
-- 3. Inbound webhook endpoints (per provider, per workspace, per project)
-- ---------------------------------------------------------------------------
-- Built-in providers already store webhook details inside
-- workspace_integrations.config; this table is the generic equivalent so custom
-- providers get real-time updates too, with a distinct secret per endpoint
-- rather than one shared global secret.
CREATE TABLE IF NOT EXISTS integration_webhook_endpoints (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider           varchar(96) NOT NULL,
  external_project_id varchar(255),           -- NULL = whole-instance endpoint

  -- Verified with crypto.timingSafeEqual against the configured header.
  secret             text NOT NULL,
  signature_header   varchar(128) NOT NULL DEFAULT 'x-asystence-token',
  -- 'token' (shared secret compare) or 'hmac_sha256' (signature over raw body)
  signature_scheme   varchar(32) NOT NULL DEFAULT 'token',

  -- Where in the payload to find the changed entity id, e.g. "issue.id"
  entity_id_path     text,

  active             boolean NOT NULL DEFAULT true,
  last_received_at   timestamptz,
  received_count     bigint NOT NULL DEFAULT 0,
  rejected_count     bigint NOT NULL DEFAULT 0,

  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT integration_webhook_endpoints_scheme_check
    CHECK (signature_scheme IN ('token', 'hmac_sha256'))
);

-- One endpoint per (workspace, provider, project). COALESCE keeps the
-- whole-instance row (NULL project) unique too, since NULL != NULL in SQL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_endpoints_unique
  ON integration_webhook_endpoints
     (workspace_id, provider, COALESCE(external_project_id, ''));

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_lookup
  ON integration_webhook_endpoints (workspace_id, provider)
  WHERE active;

-- ---------------------------------------------------------------------------
-- 4. Backfill: give every already-connected integration a config row
-- ---------------------------------------------------------------------------
-- Existing integrations keep working with sane defaults rather than silently
-- losing background sync when the worker switches to config-driven scheduling.
-- next_reconcile_at is staggered so every workspace doesn't reconcile at once.
INSERT INTO integration_sync_config (workspace_id, provider, sync_mode, next_reconcile_at)
SELECT
  wi.workspace_id,
  wi.provider,
  'webhook',
  NOW() + (random() * interval '60 minutes')
FROM workspace_integrations wi
WHERE wi.status = 'connected'
ON CONFLICT (workspace_id, provider) DO NOTHING;

COMMIT;
