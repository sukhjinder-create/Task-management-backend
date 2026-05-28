-- =============================================================================
-- Ensure Stripe price/product IDs and Checkout session metadata columns exist.
-- =============================================================================

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS stripe_product_id         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_price_monthly_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_price_yearly_id    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS stripe_currency           VARCHAR(3) NOT NULL DEFAULT 'usd';

ALTER TABLE payment_checkout_sessions
  ADD COLUMN IF NOT EXISTS session_type         VARCHAR(30) NOT NULL DEFAULT 'subscription',
  ADD COLUMN IF NOT EXISTS activation_user_ids  UUID[];

COMMENT ON COLUMN billing_plans.stripe_product_id IS 'Stripe Product ID set via the superadmin sync-stripe endpoint';
COMMENT ON COLUMN billing_plans.stripe_price_monthly_id IS 'Stripe Price ID for monthly billing interval';
COMMENT ON COLUMN billing_plans.stripe_price_yearly_id IS 'Stripe Price ID for yearly billing interval';
COMMENT ON COLUMN billing_plans.stripe_currency IS 'ISO 4217 currency code used in Stripe, such as usd or inr';
COMMENT ON COLUMN payment_checkout_sessions.session_type IS 'subscription | activation';
COMMENT ON COLUMN payment_checkout_sessions.activation_user_ids IS 'User IDs being activated for session_type=activation';

CREATE INDEX IF NOT EXISTS idx_billing_plans_stripe_monthly
  ON billing_plans(stripe_price_monthly_id)
  WHERE stripe_price_monthly_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_plans_stripe_yearly
  ON billing_plans(stripe_price_yearly_id)
  WHERE stripe_price_yearly_id IS NOT NULL;
