-- Enterprise completion foundation
-- Additive only: existing authentication, work-management, assurance, and
-- client-portal records remain valid and keep their current defaults.

-- Durable, tenant-addressable outbound webhook queue.
ALTER TABLE public.webhook_deliveries
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS delivery_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

UPDATE public.webhook_deliveries delivery
   SET workspace_id = webhook.workspace_id
  FROM public.webhooks webhook
 WHERE delivery.webhook_id = webhook.id
   AND delivery.workspace_id IS NULL;

ALTER TABLE public.webhook_deliveries
  ALTER COLUMN workspace_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'webhook_deliveries_status_check'
       AND conrelid = 'public.webhook_deliveries'::regclass
  ) THEN
    ALTER TABLE public.webhook_deliveries
      ADD CONSTRAINT webhook_deliveries_status_check
      CHECK (status IN ('pending', 'processing', 'delivered', 'dead')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.oauth_service_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_service_account_user_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.users(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT oauth_service_account_client_check CHECK (client_id ~ '^asy_client_[a-f0-9]{32}$')
);
CREATE INDEX IF NOT EXISTS idx_oauth_service_accounts_workspace
  ON public.oauth_service_accounts(workspace_id, created_at DESC);
ALTER TABLE public.oauth_service_accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.backup_logs
  ADD COLUMN IF NOT EXISTS sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS encryption_key_id TEXT;

UPDATE public.webhook_deliveries
   SET status = CASE WHEN success THEN 'delivered' ELSE 'dead' END,
       completed_at = CASE WHEN success THEN created_at ELSE NULL END
 WHERE status = 'pending' AND attempt_count = 0 AND created_at < now();

ALTER TABLE public.webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_status_check;
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_delivery_id
  ON public.webhook_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON public.webhook_deliveries(next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace
  ON public.webhook_deliveries(workspace_id, created_at DESC);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Standards-compliant enterprise SAML/OIDC configuration and short-lived
-- request correlation. Existing SAML columns remain supported.
ALTER TABLE public.workspace_sso_configs
  ADD COLUMN IF NOT EXISTS idp_issuer TEXT,
  ADD COLUMN IF NOT EXISTS audience TEXT,
  ADD COLUMN IF NOT EXISTS oidc_issuer_url TEXT,
  ADD COLUMN IF NOT EXISTS oidc_client_id TEXT,
  ADD COLUMN IF NOT EXISTS oidc_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS oidc_scopes TEXT[] NOT NULL DEFAULT ARRAY['openid','email','profile']::TEXT[],
  ADD COLUMN IF NOT EXISTS allowed_domains TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS jit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS want_authn_response_signed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.saml_request_cache (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key_hash CHAR(64) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, key_hash),
  CONSTRAINT saml_request_cache_hash_check CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT saml_request_cache_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_saml_request_cache_expiry
  ON public.saml_request_cache(expires_at);
ALTER TABLE public.saml_request_cache ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.oidc_auth_states (
  state_hash CHAR(64) PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT,
  created_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT oidc_auth_states_hash_check CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT oidc_auth_states_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_oidc_auth_states_expiry
  ON public.oidc_auth_states(expires_at);
ALTER TABLE public.oidc_auth_states ENABLE ROW LEVEL SECURITY;

-- Workspace security policy. Defaults deliberately preserve every existing
-- login and user flow until an administrator opts into a stricter control.
CREATE TABLE IF NOT EXISTS public.workspace_security_policies (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  require_mfa BOOLEAN NOT NULL DEFAULT FALSE,
  enforce_sso BOOLEAN NOT NULL DEFAULT FALSE,
  session_max_age_minutes INTEGER NOT NULL DEFAULT 10080,
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 10080,
  allowed_ip_cidrs TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  guest_access_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  api_key_max_age_days INTEGER NOT NULL DEFAULT 365,
  audit_retention_days INTEGER NOT NULL DEFAULT 365,
  data_retention_days INTEGER,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_security_session_age_check CHECK (session_max_age_minutes BETWEEN 15 AND 525600),
  CONSTRAINT workspace_security_idle_check CHECK (idle_timeout_minutes BETWEEN 5 AND 525600),
  CONSTRAINT workspace_security_api_key_age_check CHECK (api_key_max_age_days BETWEEN 1 AND 3650),
  CONSTRAINT workspace_security_audit_retention_check CHECK (audit_retention_days BETWEEN 30 AND 3650),
  CONSTRAINT workspace_security_data_retention_check CHECK (data_retention_days IS NULL OR data_retention_days BETWEEN 30 AND 3650)
);
ALTER TABLE public.workspace_security_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_sessions
  ADD COLUMN IF NOT EXISTS family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS absolute_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE public.user_sessions SET absolute_expires_at = expires_at WHERE absolute_expires_at IS NULL;
ALTER TABLE public.user_sessions ALTER COLUMN absolute_expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_sessions_family ON public.user_sessions(family_id);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- Verified ownership is separate from SSO configuration so a domain can be
-- claimed before an IdP is turned on.
CREATE TABLE IF NOT EXISTS public.workspace_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  verification_token_hash CHAR(64) NOT NULL,
  verification_token_ciphertext TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  verified_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_domains_status_check CHECK (status IN ('pending','verified')),
  CONSTRAINT workspace_domains_token_check CHECK (verification_token_hash ~ '^[a-f0-9]{64}$'),
  UNIQUE (domain),
  UNIQUE (workspace_id, id)
);
ALTER TABLE public.workspace_domains ENABLE ROW LEVEL SECURITY;

-- Optional custom roles are enforced only for memberships assigned one. This
-- leaves every existing role untouched while enabling least privilege.
CREATE TABLE IF NOT EXISTS public.enterprise_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  base_role TEXT NOT NULL DEFAULT 'user',
  permissions TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_roles_base_role_check CHECK (base_role IN ('user','manager','admin')),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);
ALTER TABLE public.enterprise_roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.workspace_users ADD COLUMN IF NOT EXISTS enterprise_role_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_users_enterprise_role_fkey') THEN
    ALTER TABLE public.workspace_users
      ADD CONSTRAINT workspace_users_enterprise_role_fkey
      FOREIGN KEY (workspace_id, enterprise_role_id)
      REFERENCES public.enterprise_roles(workspace_id, id) ON DELETE SET NULL;
  END IF;
END $$;

-- SCIM 2.0 provisioning credentials and directory objects.
CREATE TABLE IF NOT EXISTS public.scim_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scim_tokens_hash_check CHECK (token_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_workspace ON public.scim_tokens(workspace_id, created_at DESC);
ALTER TABLE public.scim_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.scim_external_identities (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  external_id TEXT,
  provider TEXT NOT NULL DEFAULT 'scim',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_attributes JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT scim_identity_user_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.users(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, external_id)
);
ALTER TABLE public.scim_external_identities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.scim_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  external_id TEXT,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, display_name),
  UNIQUE (workspace_id, external_id)
);
ALTER TABLE public.scim_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.scim_group_members (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, group_id, user_id),
  CONSTRAINT scim_group_member_group_fkey FOREIGN KEY (workspace_id, group_id)
    REFERENCES public.scim_groups(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scim_group_member_user_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.users(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE public.scim_group_members ENABLE ROW LEVEL SECURITY;

-- Tamper-evident audit chain. Historical rows remain readable; new rows are
-- chained from the first post-migration event without rewriting history.
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS chain_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS previous_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS event_hash CHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_chain_sequence
  ON public.audit_logs(workspace_id, chain_sequence)
  WHERE chain_sequence IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_event_hash
  ON public.audit_logs(workspace_id, event_hash)
  WHERE event_hash IS NOT NULL;

ALTER TABLE public.gdpr_erasure_requests
  ADD COLUMN IF NOT EXISTS processed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS result JSONB;

CREATE TABLE IF NOT EXISTS public.privacy_legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  released_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  CONSTRAINT privacy_legal_holds_user_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.users(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_privacy_legal_holds_active
  ON public.privacy_legal_holds(workspace_id, user_id) WHERE active = TRUE;
ALTER TABLE public.privacy_legal_holds ENABLE ROW LEVEL SECURITY;

-- Per-workspace Ed25519 keys make assurance receipts independently verifiable.
-- Private material is application-encrypted; public keys remain available
-- after rotation so historical signatures continue to verify.
CREATE TABLE IF NOT EXISTS public.outcome_signing_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL DEFAULT 'Ed25519',
  public_key_pem TEXT NOT NULL,
  private_key_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT outcome_signing_algorithm_check CHECK (algorithm = 'Ed25519'),
  CONSTRAINT outcome_signing_status_check CHECK (status IN ('active','retired')),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_signing_one_active
  ON public.outcome_signing_keys(workspace_id) WHERE status='active';
ALTER TABLE public.outcome_signing_keys ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.assurance_outcome_receipts
  ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS signing_key_id UUID,
  ADD COLUMN IF NOT EXISTS signature_algorithm TEXT,
  ADD COLUMN IF NOT EXISTS signature TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assurance_receipt_public_id
  ON public.assurance_outcome_receipts(public_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_receipt_signing_key_fkey') THEN
    ALTER TABLE public.assurance_outcome_receipts
      ADD CONSTRAINT assurance_receipt_signing_key_fkey
      FOREIGN KEY (workspace_id, signing_key_id)
      REFERENCES public.outcome_signing_keys(workspace_id, id);
  END IF;
END $$;

-- A review keeps its legacy primary contact while an optional approver set
-- supports all/threshold acceptance without changing the one-click default.
ALTER TABLE public.assurance_client_reviews
  ADD COLUMN IF NOT EXISTS required_approvals INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approval_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS change_request_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.assurance_client_review_approvers (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  review_id UUID NOT NULL,
  client_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, review_id, contact_id),
  CONSTRAINT client_review_approver_review_fkey
    FOREIGN KEY (workspace_id, review_id)
    REFERENCES public.assurance_client_reviews(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT client_review_approver_contact_fkey
    FOREIGN KEY (workspace_id, client_id, contact_id)
    REFERENCES public.assurance_client_contacts(workspace_id, client_id, id),
  CONSTRAINT client_review_approver_status_check
    CHECK (status IN ('pending','accepted','changes_requested','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_client_review_approvers_contact
  ON public.assurance_client_review_approvers(workspace_id, client_id, contact_id, status);
ALTER TABLE public.assurance_client_review_approvers ENABLE ROW LEVEL SECURITY;

INSERT INTO public.assurance_client_review_approvers
  (workspace_id, review_id, client_id, contact_id, status, decision_note, decided_at, created_at)
SELECT workspace_id, id, client_id, contact_id,
       CASE WHEN status IN ('pending','accepted','changes_requested') THEN status ELSE 'cancelled' END,
       decision_note, decided_at, requested_at
FROM public.assurance_client_reviews
ON CONFLICT DO NOTHING;

UPDATE public.assurance_client_reviews review SET
  approval_count=(SELECT COUNT(*) FROM public.assurance_client_review_approvers approver
                  WHERE approver.workspace_id=review.workspace_id AND approver.review_id=review.id
                    AND approver.status='accepted'),
  change_request_count=(SELECT COUNT(*) FROM public.assurance_client_review_approvers approver
                        WHERE approver.workspace_id=review.workspace_id AND approver.review_id=review.id
                          AND approver.status='changes_requested');

-- Contractual, regulatory, security and operating obligations share the same
-- outcome evidence already used by assurance; no second document store.
CREATE TABLE IF NOT EXISTS public.assurance_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  obligation_type TEXT NOT NULL DEFAULT 'operational',
  title TEXT NOT NULL,
  description TEXT,
  control_reference TEXT,
  owner_id UUID,
  due_date DATE,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  waiver_reason TEXT,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assurance_obligation_goal_fkey FOREIGN KEY (workspace_id, goal_id)
    REFERENCES public.okr_objectives(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT assurance_obligation_owner_fkey FOREIGN KEY (workspace_id, owner_id)
    REFERENCES public.users(workspace_id, id) ON DELETE SET NULL (owner_id),
  CONSTRAINT assurance_obligation_type_check
    CHECK (obligation_type IN ('contractual','regulatory','security','operational')),
  CONSTRAINT assurance_obligation_severity_check CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT assurance_obligation_status_check CHECK (status IN ('open','satisfied','waived')),
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_assurance_obligations_goal
  ON public.assurance_obligations(workspace_id, goal_id, status, due_date);
ALTER TABLE public.assurance_obligations ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_assurance_evidence_workspace_identity
  ON public.goal_assurance_evidence(workspace_id, goal_id, id);
CREATE TABLE IF NOT EXISTS public.assurance_obligation_evidence (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  obligation_id UUID NOT NULL,
  goal_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  linked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, obligation_id, evidence_id),
  CONSTRAINT obligation_evidence_obligation_fkey FOREIGN KEY (workspace_id, obligation_id)
    REFERENCES public.assurance_obligations(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT obligation_evidence_record_fkey FOREIGN KEY (workspace_id, goal_id, evidence_id)
    REFERENCES public.goal_assurance_evidence(workspace_id, goal_id, id) ON DELETE CASCADE
);
ALTER TABLE public.assurance_obligation_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.assurance_portfolios
  ADD COLUMN IF NOT EXISTS sla_grace_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minimum_verified_percent INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS review_cadence_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_portfolio_sla_grace_check') THEN
    ALTER TABLE public.assurance_portfolios ADD CONSTRAINT assurance_portfolio_sla_grace_check
      CHECK (sla_grace_days BETWEEN 0 AND 365) NOT VALID;
    ALTER TABLE public.assurance_portfolios VALIDATE CONSTRAINT assurance_portfolio_sla_grace_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_portfolio_verified_percent_check') THEN
    ALTER TABLE public.assurance_portfolios ADD CONSTRAINT assurance_portfolio_verified_percent_check
      CHECK (minimum_verified_percent BETWEEN 0 AND 100) NOT VALID;
    ALTER TABLE public.assurance_portfolios VALIDATE CONSTRAINT assurance_portfolio_verified_percent_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assurance_portfolio_review_cadence_check') THEN
    ALTER TABLE public.assurance_portfolios ADD CONSTRAINT assurance_portfolio_review_cadence_check
      CHECK (review_cadence_days BETWEEN 1 AND 365) NOT VALID;
    ALTER TABLE public.assurance_portfolios VALIDATE CONSTRAINT assurance_portfolio_review_cadence_check;
  END IF;
END $$;
