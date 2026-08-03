-- =============================================================================
-- MULTI-CURRENCY BILLING — phase 2 (contract)
--
-- DO NOT RUN THIS UNTIL THE NEW BACKEND IS FULLY DEPLOYED AND VERIFIED.
--
-- Phase 1 kept the old *_paise columns alive and mirrored them into the new
-- *_minor columns with triggers, so a pre-deploy backend and a post-deploy
-- backend could run against the same database. This drops that scaffolding.
--
-- Check before running — every row should report matched = true:
--
--   SELECT slug,
--          price_monthly_paise = price_monthly_minor AS monthly_matched,
--          price_yearly_paise  = price_yearly_minor  AS yearly_matched
--     FROM billing_plans;
--
-- If any row does not match, a write went through a path the trigger did not
-- cover. Investigate before dropping anything — the *_paise value is the one
-- the old code was serving.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_sync_billing_plan_price_columns ON billing_plans;
DROP FUNCTION IF EXISTS sync_billing_plan_price_columns();

DROP TRIGGER IF EXISTS trg_sync_workspace_seat_price_columns ON workspaces;
DROP FUNCTION IF EXISTS sync_workspace_seat_price_columns();

DO $$
BEGIN
  IF to_regclass('public.user_activation_payments') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_sync_activation_amount_columns ON user_activation_payments;

    -- amount_paise is NOT NULL, so it must lose that constraint before the new
    -- code (which writes amount_minor only) can insert.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'user_activation_payments' AND column_name = 'amount_paise'
    ) THEN
      ALTER TABLE user_activation_payments DROP COLUMN amount_paise;
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS sync_activation_amount_columns();

ALTER TABLE billing_plans
  DROP COLUMN IF EXISTS price_monthly_paise,
  DROP COLUMN IF EXISTS price_yearly_paise;

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS per_user_price_paise;

ALTER TABLE workspace_subscriptions
  DROP COLUMN IF EXISTS auth_amount_paise;

-- legacy_price_*_paise on billing_plans are deliberately kept: they are the
-- pre-repricing snapshot that scripts/reprice-plans-usd.js --rollback restores.
