-- Razorpay-backed card-required trial signup support.
-- Keeps existing Stripe columns intact and adds provider-specific IDs safely.

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS razorpay_plan_monthly_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS razorpay_plan_yearly_id  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS razorpay_currency        VARCHAR(3) NOT NULL DEFAULT 'inr';

CREATE INDEX IF NOT EXISTS idx_billing_plans_razorpay_monthly
  ON billing_plans(razorpay_plan_monthly_id)
  WHERE razorpay_plan_monthly_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_plans_razorpay_yearly
  ON billing_plans(razorpay_plan_yearly_id)
  WHERE razorpay_plan_yearly_id IS NOT NULL;

ALTER TABLE trial_signup_checkout_sessions
  ADD COLUMN IF NOT EXISTS provider_plan_id      TEXT,
  ADD COLUMN IF NOT EXISTS provider_order_id     TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_id   TEXT,
  ADD COLUMN IF NOT EXISTS provider_refund_id    TEXT,
  ADD COLUMN IF NOT EXISTS provider_signature    TEXT;

CREATE INDEX IF NOT EXISTS idx_trial_signup_checkout_subscription
  ON trial_signup_checkout_sessions(provider, subscription_id)
  WHERE subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trial_signup_provider_payment
  ON trial_signup_checkout_sessions(provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

COMMENT ON COLUMN billing_plans.razorpay_plan_monthly_id IS 'Razorpay Plan ID for monthly billing interval';
COMMENT ON COLUMN billing_plans.razorpay_plan_yearly_id IS 'Razorpay Plan ID for yearly billing interval';
COMMENT ON COLUMN billing_plans.razorpay_currency IS 'ISO 4217 currency code used in Razorpay, such as inr';
COMMENT ON COLUMN trial_signup_checkout_sessions.provider_plan_id IS 'Payment-provider plan ID used for this signup checkout';
COMMENT ON COLUMN trial_signup_checkout_sessions.provider_payment_id IS 'Payment-provider payment ID for the refundable verification charge';
COMMENT ON COLUMN trial_signup_checkout_sessions.provider_refund_id IS 'Payment-provider refund ID for the verification charge refund';

COMMENT ON TABLE trial_signup_checkout_sessions IS
  'Pending and completed card-required free-trial signups created via Stripe Checkout or Razorpay Subscriptions.';
