-- Workspace payments / subscriptions foundation
-- Stripe-oriented schema, provider-agnostic enough for future adapters.

CREATE TABLE IF NOT EXISTS payment_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe',
  customer_id text NOT NULL,
  email text,
  currency text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, customer_id),
  UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe',
  customer_id text,
  subscription_id text NOT NULL,
  status text NOT NULL DEFAULT 'incomplete',
  billing_plan text,
  price_id text,
  product_id text,
  currency text,
  interval text,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subscription_id),
  UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS payment_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'stripe',
  checkout_session_id text NOT NULL,
  customer_id text,
  subscription_id text,
  price_id text,
  billing_plan text,
  status text NOT NULL DEFAULT 'pending',
  success_url text,
  cancel_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, checkout_session_id)
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'stripe',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  api_version text,
  livemode boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_status text,
  ADD COLUMN IF NOT EXISTS billing_provider text,
  ADD COLUMN IF NOT EXISTS billing_customer_id text,
  ADD COLUMN IF NOT EXISTS billing_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS billing_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_payment_customers_workspace
  ON payment_customers(workspace_id, provider);

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_workspace
  ON workspace_subscriptions(workspace_id, provider);

CREATE INDEX IF NOT EXISTS idx_payment_checkout_sessions_workspace
  ON payment_checkout_sessions(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_type
  ON payment_webhook_events(event_type, created_at DESC);
