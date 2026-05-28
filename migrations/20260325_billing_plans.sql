-- =============================================================================
-- BILLING PLANS - superadmin-configurable Stripe plan catalog
-- Prices are stored in the smallest currency unit used by Stripe.
-- =============================================================================

CREATE TABLE IF NOT EXISTS billing_plans (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     VARCHAR(100)  NOT NULL,
  slug                     VARCHAR(50)   UNIQUE NOT NULL,
  tagline                  VARCHAR(200),
  description              TEXT,
  price_monthly_paise      INTEGER       NOT NULL DEFAULT 0,
  price_yearly_paise       INTEGER       NOT NULL DEFAULT 0,
  yearly_discount_pct      SMALLINT      NOT NULL DEFAULT 0,
  member_limit             INTEGER       NOT NULL DEFAULT 10,
  max_projects             INTEGER,
  max_integrations         INTEGER,
  storage_limit_gb         INTEGER,
  features                 JSONB         NOT NULL DEFAULT '[]',
  support_level            VARCHAR(30)   NOT NULL DEFAULT 'community',
  trial_days               SMALLINT      NOT NULL DEFAULT 7,
  grace_period_days        SMALLINT      NOT NULL DEFAULT 3,
  is_active                BOOLEAN       NOT NULL DEFAULT true,
  is_popular               BOOLEAN       NOT NULL DEFAULT false,
  is_custom                BOOLEAN       NOT NULL DEFAULT false,
  stripe_product_id        VARCHAR(100),
  stripe_price_monthly_id  VARCHAR(100),
  stripe_price_yearly_id   VARCHAR(100),
  stripe_currency          VARCHAR(3)    NOT NULL DEFAULT 'usd',
  display_order            SMALLINT      NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS stripe_product_id        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_price_monthly_id  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_price_yearly_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_currency          VARCHAR(3) NOT NULL DEFAULT 'usd';

ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS billing_plan_id       UUID REFERENCES billing_plans(id),
  ADD COLUMN IF NOT EXISTS billing_interval      VARCHAR(20) DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS next_billing_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_period_ends_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_failure_count SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_id       TEXT;

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
    999, 9990, 17,
    50, NULL, 5,
    '["Up to 50 members","Unlimited projects","Advanced analytics","Custom workflows","Time tracking","Leave management","OKR & Goals","5 integrations","Priority email support","Audit logs (30 days)"]'::jsonb,
    'email', 7, 3,
    true, true, 1
  ),
  (
    'Enterprise', 'enterprise', 'For large organizations at scale',
    2999, 29990, 17,
    200, NULL, NULL,
    '["Up to 200 members","Everything in Pro","SSO / SAML login","Full audit logs","Dedicated account manager","Unlimited integrations","Custom branding","SLA guarantee","On-premise deployment option","99.9% uptime SLA"]'::jsonb,
    'dedicated', 7, 7,
    true, false, 2
  )
ON CONFLICT (slug) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_billing_plans_active
  ON billing_plans(is_active, display_order);

CREATE INDEX IF NOT EXISTS idx_ws_sub_billing_plan
  ON workspace_subscriptions(billing_plan_id);

CREATE INDEX IF NOT EXISTS idx_billing_plans_stripe_monthly
  ON billing_plans(stripe_price_monthly_id)
  WHERE stripe_price_monthly_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_plans_stripe_yearly
  ON billing_plans(stripe_price_yearly_id)
  WHERE stripe_price_yearly_id IS NOT NULL;
