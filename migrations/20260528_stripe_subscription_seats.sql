-- =============================================================================
-- Stripe recurring seat quantity tracking.
-- Keeps the Stripe subscription item quantity aligned with billable users.
-- =============================================================================

ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS subscription_item_id TEXT,
  ADD COLUMN IF NOT EXISTS seat_quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS seat_quantity_synced_at TIMESTAMPTZ;

ALTER TABLE payment_checkout_sessions
  ADD COLUMN IF NOT EXISTS seat_quantity INTEGER;

ALTER TABLE user_activation_payments
  ADD COLUMN IF NOT EXISTS seat_quantity_before INTEGER,
  ADD COLUMN IF NOT EXISTS seat_quantity_after INTEGER,
  ADD COLUMN IF NOT EXISTS subscription_item_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_quantity_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN workspace_subscriptions.subscription_item_id IS 'Stripe subscription item ID whose quantity represents billable seats';
COMMENT ON COLUMN workspace_subscriptions.seat_quantity IS 'Last known recurring Stripe seat quantity';
COMMENT ON COLUMN workspace_subscriptions.seat_quantity_synced_at IS 'When local billable user count was last pushed to Stripe';
COMMENT ON COLUMN payment_checkout_sessions.seat_quantity IS 'Billable seat quantity used when creating the Stripe Checkout session';
COMMENT ON COLUMN user_activation_payments.seat_quantity_before IS 'Billable seats before this activation payment';
COMMENT ON COLUMN user_activation_payments.seat_quantity_after IS 'Billable seats expected after this activation payment';
COMMENT ON COLUMN user_activation_payments.subscription_quantity_synced_at IS 'When this activation updated the Stripe recurring quantity';

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_subscription_item
  ON workspace_subscriptions(subscription_item_id)
  WHERE subscription_item_id IS NOT NULL;
