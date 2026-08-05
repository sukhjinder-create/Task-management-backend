-- ====================================================================
-- Enterprise Phase 1: Security & Compliance
-- Audit Logs, MFA columns, SSO config, Leave, Wiki, OKR tables
-- ====================================================================

-- ─── AUDIT LOGS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,          -- e.g. 'task.create', 'user.login', 'role.change'
  entity_type   TEXT,                   -- 'task', 'project', 'user', etc.
  entity_id     TEXT,
  old_value     JSONB,
  new_value     JSONB,
  ip_address    TEXT,
  user_agent    TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user      ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action    ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity    ON audit_logs(entity_type, entity_id);

-- ─── MFA COLUMNS ON USERS ─────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_secret      TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT[];

-- ─── SSO CONFIG PER WORKSPACE ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_sso_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'saml',   -- 'saml' | 'oidc'
  enabled          BOOLEAN NOT NULL DEFAULT false,
  entry_point      TEXT,    -- IdP SSO URL
  issuer           TEXT,    -- SP entity ID
  cert             TEXT,    -- IdP public certificate (PEM)
  sp_callback_url  TEXT,    -- Our ACS URL
  attribute_email  TEXT NOT NULL DEFAULT 'email',
  attribute_name   TEXT NOT NULL DEFAULT 'displayName',
  force_sso        BOOLEAN NOT NULL DEFAULT false,  -- disallow password login
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── LEAVE MANAGEMENT ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_types (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,          -- 'Annual', 'Sick', 'Unpaid', etc.
  color        TEXT NOT NULL DEFAULT '#6366f1',
  max_days     NUMERIC(5,1),           -- NULL = unlimited
  carry_over   BOOLEAN NOT NULL DEFAULT false,
  requires_doc BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  days          NUMERIC(4,1) NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
  reviewed_by   UUID REFERENCES users(id),
  review_note   TEXT,
  reviewed_at   TIMESTAMPTZ,
  document_url  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_workspace ON leave_requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user      ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status    ON leave_requests(status);

-- Leave balance per user per year
CREATE TABLE IF NOT EXISTS leave_balances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year          INT NOT NULL DEFAULT EXTRACT(YEAR FROM NOW()),
  allocated     NUMERIC(5,1) NOT NULL DEFAULT 0,
  used          NUMERIC(5,1) NOT NULL DEFAULT 0,
  UNIQUE(workspace_id, user_id, leave_type_id, year)
);

-- ─── WIKI / DOCS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wiki_spaces (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  icon         TEXT DEFAULT '📄',
  is_private   BOOLEAN NOT NULL DEFAULT false,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS wiki_pages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     UUID NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES wiki_pages(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT DEFAULT '',       -- TipTap JSON stored as text
  content_text TEXT DEFAULT '',       -- plain text for search
  icon         TEXT,
  cover_url    TEXT,
  position     INT NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID REFERENCES users(id),
  updated_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(space_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_space    ON wiki_pages(space_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_parent   ON wiki_pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_content  ON wiki_pages USING gin(to_tsvector('english', content_text));

CREATE TABLE IF NOT EXISTS wiki_page_versions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id    UUID NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  title      TEXT NOT NULL,
  version    INT NOT NULL,
  edited_by  UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── OKR / GOALS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS okr_objectives (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id     UUID REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT,
  time_period  TEXT NOT NULL,   -- 'Q1 2026', '2026', etc.
  status       TEXT NOT NULL DEFAULT 'on_track',  -- on_track | at_risk | off_track | done
  progress     NUMERIC(5,2) NOT NULL DEFAULT 0,  -- 0-100
  parent_id    UUID REFERENCES okr_objectives(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS okr_key_results (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id UUID NOT NULL REFERENCES okr_objectives(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  owner_id     UUID REFERENCES users(id),
  type         TEXT NOT NULL DEFAULT 'number',  -- number | percentage | boolean | currency
  start_value  NUMERIC DEFAULT 0,
  target_value NUMERIC NOT NULL,
  current_value NUMERIC DEFAULT 0,
  unit         TEXT,
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'on_track',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_okr_objectives_workspace ON okr_objectives(workspace_id);
CREATE INDEX IF NOT EXISTS idx_okr_key_results_obj      ON okr_key_results(objective_id);

-- ─── PERFORMANCE REVIEWS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_cycles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,    -- 'Q1 2026 Review'
  type         TEXT NOT NULL DEFAULT 'quarterly',  -- quarterly | annual | 360
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | active | completed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      UUID NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  reviewee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'manager',  -- self | peer | manager | upward
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | submitted
  overall_score NUMERIC(3,1),    -- 1-5
  strengths     TEXT,
  improvements  TEXT,
  goals_next    TEXT,
  answers       JSONB DEFAULT '[]',   -- [{question, answer, score}]
  submitted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cycle_id, reviewee_id, reviewer_id, type)
);

CREATE INDEX IF NOT EXISTS idx_reviews_cycle    ON performance_reviews(cycle_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON performance_reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON performance_reviews(reviewer_id);

-- ─── GDPR CONSENT LOG ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gdpr_consents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,    -- 'terms', 'privacy_policy', 'marketing'
  version     TEXT NOT NULL,
  consented   BOOLEAN NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gdpr_erasure_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id      UUID NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  notes        TEXT
);

-- ─── API KEYS (for Public API / Phase 4) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,    -- bcrypt hash of the actual key
  key_prefix   TEXT NOT NULL,           -- first 8 chars for display
  scopes       TEXT[] NOT NULL DEFAULT '{}',   -- ['read:tasks', 'write:tasks', ...]
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix    ON api_keys(key_prefix);

-- ─── WEBHOOKS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  secret       TEXT,
  events       TEXT[] NOT NULL DEFAULT '{}',  -- ['task.created', 'task.updated', ...]
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_fired_at TIMESTAMPTZ,
  failure_count INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_workspace ON webhooks(workspace_id);

-- ─── WEBHOOK DELIVERY LOG ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  response_status INT,
  response_body   TEXT,
  duration_ms  INT,
  success      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- Supabase exposes every table over its public REST API, so RLS is what stops an
-- anon/authenticated key reading this directly, bypassing the backend and its
-- permission checks. Enabled here, in the migration that creates the table,
-- rather than in a later sweep: 20260430_enable_rls_all_tables.sql listed tables
-- by name, so every table created after it silently arrived unprotected -- 85 of
-- them by 2026-08-05. Protecting the table where it is born is what stops that
-- recurring. The backend is unaffected; it connects as the owner, and owners
-- bypass RLS unless FORCE is set (it is not).
ALTER TABLE public.okr_key_results ENABLE ROW LEVEL SECURITY;
