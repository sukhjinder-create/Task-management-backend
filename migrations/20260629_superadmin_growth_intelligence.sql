-- Super Admin sessions and platform Growth Intelligence telemetry.
-- Additive and rollback-safe: no existing auth or product tables are changed.

CREATE TABLE IF NOT EXISTS superadmin_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  superadmin_id         UUID NOT NULL REFERENCES superadmins(id) ON DELETE CASCADE,
  refresh_token_hash    TEXT NOT NULL UNIQUE,
  ip_hash               TEXT,
  user_agent            TEXT,
  last_used_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_superadmin_sessions_admin
  ON superadmin_sessions (superadmin_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_superadmin_sessions_expiry
  ON superadmin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS growth_events (
  id                    UUID PRIMARY KEY,
  event_name            VARCHAR(120) NOT NULL,
  category              VARCHAR(32) NOT NULL,
  source                VARCHAR(32) NOT NULL,
  actor_user_id         UUID,
  workspace_id          TEXT,
  anonymous_id          VARCHAR(80),
  session_id            VARCHAR(80),
  entity_type           VARCHAR(80),
  entity_id             TEXT,
  page_path             TEXT,
  landing_page          TEXT,
  referrer_host         TEXT,
  traffic_source        VARCHAR(80),
  utm_source            VARCHAR(160),
  utm_medium            VARCHAR(160),
  utm_campaign          VARCHAR(160),
  device_type           VARCHAR(32),
  browser               VARCHAR(64),
  country_code          VARCHAR(8),
  properties            JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at           TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT growth_events_category_check
    CHECK (category IN ('website', 'acquisition', 'activation', 'engagement', 'retention', 'system')),
  CONSTRAINT growth_events_identity_check
    CHECK (actor_user_id IS NOT NULL OR anonymous_id IS NOT NULL OR session_id IS NOT NULL OR source = 'server')
);

CREATE INDEX IF NOT EXISTS idx_growth_events_time
  ON growth_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_name_time
  ON growth_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_workspace_time
  ON growth_events (workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_growth_events_actor_time
  ON growth_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_growth_events_session_time
  ON growth_events (session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_growth_events_properties
  ON growth_events USING GIN (properties);

COMMENT ON TABLE growth_events IS
  'Privacy-minimized, append-only platform adoption telemetry for Super Admin Growth Intelligence.';
COMMENT ON COLUMN growth_events.properties IS
  'Allowlisted operational metadata only. Message, AI prompt, password, and private content are forbidden.';

-- These tables are server-owned. Enabling RLS prevents browser roles from
-- gaining direct access even if their grants change later.
ALTER TABLE superadmin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_events ENABLE ROW LEVEL SECURITY;

