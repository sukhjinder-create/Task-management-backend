-- Card-required trial signup sessions.
-- Workspace/user rows are provisioned only after Stripe Checkout confirms.

CREATE TABLE IF NOT EXISTS trial_signup_checkout_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              TEXT NOT NULL DEFAULT 'stripe',
  checkout_session_id   TEXT UNIQUE,
  customer_id           TEXT,
  subscription_id       TEXT,
  payment_intent_id     TEXT,
  refund_id             TEXT,
  status                VARCHAR(30) NOT NULL DEFAULT 'created',
  workspace_id          UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  owner_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_name        TEXT NOT NULL,
  owner_name            TEXT NOT NULL,
  owner_email           TEXT NOT NULL,
  owner_password_hash   TEXT,
  auth_provider         VARCHAR(30) NOT NULL DEFAULT 'email',
  avatar_url            TEXT,
  billing_plan_id       UUID REFERENCES billing_plans(id),
  billing_plan          TEXT,
  billing_interval      VARCHAR(20) NOT NULL DEFAULT 'monthly',
  verification_amount   INTEGER NOT NULL,
  currency              VARCHAR(3) NOT NULL DEFAULT 'inr',
  consent_accepted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  consent_ip_hash       TEXT,
  consent_user_agent    TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trial_signup_checkout_session
  ON trial_signup_checkout_sessions(provider, checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_trial_signup_checkout_email
  ON trial_signup_checkout_sessions(lower(owner_email), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trial_signup_checkout_ip
  ON trial_signup_checkout_sessions(consent_ip_hash, created_at DESC)
  WHERE consent_ip_hash IS NOT NULL;

COMMENT ON TABLE trial_signup_checkout_sessions IS
  'Pending and completed card-required free-trial signups created via Stripe Checkout.';

COMMENT ON COLUMN payment_checkout_sessions.session_type IS 'subscription | activation | trial_signup';
