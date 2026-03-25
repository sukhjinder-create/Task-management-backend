-- =============================================================================
-- BILLING PLANS — Superadmin-configurable plan catalog
-- Razorpay-native (UPI AutoPay, Cards, NACH mandates, ₹1 auth verification)
-- =============================================================================

-- ── Plan catalog ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_plans (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    VARCHAR(100)  NOT NULL,
  slug                    VARCHAR(50)   UNIQUE NOT NULL,       -- "starter", "pro", "enterprise"
  tagline                 VARCHAR(200),                        -- "Built for growing teams"
  description             TEXT,
  price_monthly_paise     INTEGER       NOT NULL DEFAULT 0,    -- ₹999 = 99900 paise
  price_yearly_paise      INTEGER       NOT NULL DEFAULT 0,    -- ₹9999 = 999900 paise (yearly)
  yearly_discount_pct     SMALLINT      NOT NULL DEFAULT 0,    -- e.g. 17 for 17% off
  member_limit            INTEGER       NOT NULL DEFAULT 10,   -- max workspace members
  max_projects            INTEGER,                             -- NULL = unlimited
  max_integrations        INTEGER,                             -- NULL = unlimited
  storage_limit_gb        INTEGER,                             -- NULL = unlimited
  features                JSONB         NOT NULL DEFAULT '[]', -- array of feature strings
  support_level           VARCHAR(30)   NOT NULL DEFAULT 'community', -- community|email|priority|dedicated
  trial_days              SMALLINT      NOT NULL DEFAULT 7,    -- 0 = no trial
  grace_period_days       SMALLINT      NOT NULL DEFAULT 3,    -- days after failed payment before suspension
  is_active               BOOLEAN       NOT NULL DEFAULT true,
  is_popular              BOOLEAN       NOT NULL DEFAULT false, -- "Most Popular" badge
  is_custom               BOOLEAN       NOT NULL DEFAULT false, -- enterprise custom quote
  -- Razorpay plan IDs (populated when superadmin syncs to Razorpay)
  razorpay_monthly_plan_id VARCHAR(100),
  razorpay_yearly_plan_id  VARCHAR(100),
  display_order           SMALLINT      NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Subscription state (extend existing table) ────────────────────────────────
ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS billing_plan_id       UUID REFERENCES billing_plans(id),
  ADD COLUMN IF NOT EXISTS billing_interval      VARCHAR(20)  DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS mandate_id            TEXT,        -- Razorpay mandate ID
  ADD COLUMN IF NOT EXISTS razorpay_customer_id  TEXT,
  ADD COLUMN IF NOT EXISTS auth_amount_paise     INTEGER      DEFAULT 100,  -- ₹1 for verification
  ADD COLUMN IF NOT EXISTS auth_refunded         BOOLEAN      DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_billing_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_period_ends_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_failure_count SMALLINT     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_id       TEXT;        -- Razorpay payment ID

-- ── Seed default plans ────────────────────────────────────────────────────────
INSERT INTO billing_plans (
  name, slug, tagline,
  price_monthly_paise, price_yearly_paise, yearly_discount_pct,
  member_limit, max_projects, max_integrations,
  features, support_level, trial_days, grace_period_days,
  is_active, is_popular, display_order
) VALUES
  (
    'Starter', 'starter', 'Free forever for small teams',
    0, 0, 0,
    10, 5, 1,
    '["Up to 10 members","5 projects","Core task management","Basic reporting","Community support","1 integration"]'::jsonb,
    'community', 0, 0,
    true, false, 0
  ),
  (
    'Pro', 'pro', 'Everything your growing team needs',
    99900, 999900, 17,
    50, NULL, 5,
    '["Up to 50 members","Unlimited projects","Advanced analytics","Custom workflows","Time tracking","Leave management","OKR & Goals","5 integrations","Priority email support","Audit logs (30 days)"]'::jsonb,
    'email', 7, 3,
    true, true, 1
  ),
  (
    'Enterprise', 'enterprise', 'For large organisations at scale',
    299900, 2999900, 17,
    200, NULL, NULL,
    '["Up to 200 members","Everything in Pro","SSO / SAML login","Full audit logs","Dedicated account manager","Unlimited integrations","Custom branding","SLA guarantee","On-premise deployment option","99.9% uptime SLA"]'::jsonb,
    'dedicated', 7, 7,
    true, false, 2
  )
ON CONFLICT (slug) DO NOTHING;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_billing_plans_active
  ON billing_plans(is_active, display_order);

CREATE INDEX IF NOT EXISTS idx_ws_sub_billing_plan
  ON workspace_subscriptions(billing_plan_id);
