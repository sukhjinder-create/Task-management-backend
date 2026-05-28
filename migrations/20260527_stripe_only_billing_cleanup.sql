-- =============================================================================
-- Stripe-only billing cleanup.
-- Removes legacy Razorpay-specific columns from installations that already ran
-- the earlier billing migrations.
-- =============================================================================

ALTER TABLE IF EXISTS billing_plans
  DROP COLUMN IF EXISTS razorpay_monthly_plan_id,
  DROP COLUMN IF EXISTS razorpay_yearly_plan_id;

ALTER TABLE IF EXISTS workspace_subscriptions
  DROP COLUMN IF EXISTS razorpay_customer_id,
  DROP COLUMN IF EXISTS mandate_id,
  DROP COLUMN IF EXISTS auth_amount_paise,
  DROP COLUMN IF EXISTS auth_refunded;

DO $$
BEGIN
  IF to_regclass('public.user_activation_payments') IS NOT NULL THEN
    ALTER TABLE user_activation_payments
      ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'stripe',
      ADD COLUMN IF NOT EXISTS checkout_session_id TEXT,
      ADD COLUMN IF NOT EXISTS payment_intent_id TEXT,
      DROP COLUMN IF EXISTS razorpay_order_id,
      DROP COLUMN IF EXISTS razorpay_payment_id,
      DROP COLUMN IF EXISTS razorpay_signature;

    ALTER TABLE user_activation_payments
      DROP CONSTRAINT IF EXISTS user_activation_payments_status_check;

    ALTER TABLE user_activation_payments
      ADD CONSTRAINT user_activation_payments_status_check
      CHECK (status IN ('created', 'paid', 'failed', 'expired'));
  END IF;
END $$;
