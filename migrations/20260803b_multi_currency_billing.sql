-- =============================================================================
-- MULTI-CURRENCY BILLING — phase 1 (expand)
--
-- Moves the plan catalog off "rupees/paise" and onto a currency-neutral model:
--
--   billing_plans.base_currency        list currency the plan is authored in (usd)
--   billing_plans.price_*_minor        list price in the base currency's minor unit
--   billing_plan_prices                published price book, one row per currency
--   billing_plan_provider_prices       Stripe Price / Razorpay Plan IDs per currency
--   fx_rates                           cached USD-based FX rates
--
-- SAFE TO RUN AGAINST A LIVE DEPLOYMENT, BEFORE OR AFTER THE CODE DEPLOY.
--
-- This is the "expand" half of an expand/contract migration. The old *_paise
-- columns are NOT renamed or dropped — they are kept and held in sync with the
-- new *_minor columns by triggers, in both directions. Old code reading
-- price_monthly_paise and new code reading price_monthly_minor both see the
-- same number, so there is no window where the deployed backend reads NULL.
--
-- That matters specifically because the old isFreePlan() treats a missing price
-- as free, which would silently switch signup from "card required" to "free"
-- for every plan.
--
-- Phase 2 (20260804_multi_currency_billing_contract.sql) drops the old columns
-- and the triggers — run it only once the new backend is fully deployed.
--
-- Existing numeric values are NOT changed. The columns are widened and copied,
-- never reinterpreted; repricing is a separate, deliberate step
-- (scripts/reprice-plans-usd.js).
-- =============================================================================

-- ── billing_plans: currency-neutral price columns ────────────────────────────

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS price_monthly_minor        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_yearly_minor         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_currency              VARCHAR(3)  NOT NULL DEFAULT 'usd',
  ADD COLUMN IF NOT EXISTS legacy_price_monthly_paise INTEGER,
  ADD COLUMN IF NOT EXISTS legacy_price_yearly_paise  INTEGER,
  ADD COLUMN IF NOT EXISTS repriced_at                TIMESTAMPTZ;

-- Backfill the new columns from the live ones, and snapshot the originals so a
-- bad reprice is reversible.
UPDATE billing_plans
   SET price_monthly_minor = price_monthly_paise,
       price_yearly_minor  = price_yearly_paise
 WHERE price_monthly_minor = 0
   AND price_yearly_minor = 0
   AND (price_monthly_paise <> 0 OR price_yearly_paise <> 0);

UPDATE billing_plans
   SET legacy_price_monthly_paise = price_monthly_paise,
       legacy_price_yearly_paise  = price_yearly_paise
 WHERE legacy_price_monthly_paise IS NULL
   AND legacy_price_yearly_paise IS NULL;

COMMENT ON COLUMN billing_plans.price_monthly_minor IS
  'Monthly list price per seat in the minor unit of base_currency (USD cents by default)';
COMMENT ON COLUMN billing_plans.price_yearly_minor IS
  'Yearly list price per seat in the minor unit of base_currency (USD cents by default)';
COMMENT ON COLUMN billing_plans.base_currency IS
  'ISO 4217 currency the plan is authored in. All other currencies derive from this one.';
COMMENT ON COLUMN billing_plans.legacy_price_monthly_paise IS
  'Pre-multi-currency value of price_monthly_paise, kept so a reprice can be rolled back';

-- Two-way sync so the pre-deploy and post-deploy backends agree.
-- On UPDATE, whichever side actually changed wins. On INSERT, whichever side
-- was populated wins (both zero = a genuinely free plan, left alone).
CREATE OR REPLACE FUNCTION sync_billing_plan_price_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.price_monthly_minor, 0) = 0 AND COALESCE(NEW.price_monthly_paise, 0) <> 0 THEN
      NEW.price_monthly_minor := NEW.price_monthly_paise;
    ELSIF COALESCE(NEW.price_monthly_paise, 0) = 0 AND COALESCE(NEW.price_monthly_minor, 0) <> 0 THEN
      NEW.price_monthly_paise := NEW.price_monthly_minor;
    END IF;

    IF COALESCE(NEW.price_yearly_minor, 0) = 0 AND COALESCE(NEW.price_yearly_paise, 0) <> 0 THEN
      NEW.price_yearly_minor := NEW.price_yearly_paise;
    ELSIF COALESCE(NEW.price_yearly_paise, 0) = 0 AND COALESCE(NEW.price_yearly_minor, 0) <> 0 THEN
      NEW.price_yearly_paise := NEW.price_yearly_minor;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.price_monthly_minor IS DISTINCT FROM OLD.price_monthly_minor THEN
      NEW.price_monthly_paise := NEW.price_monthly_minor;
    ELSIF NEW.price_monthly_paise IS DISTINCT FROM OLD.price_monthly_paise THEN
      NEW.price_monthly_minor := NEW.price_monthly_paise;
    END IF;

    IF NEW.price_yearly_minor IS DISTINCT FROM OLD.price_yearly_minor THEN
      NEW.price_yearly_paise := NEW.price_yearly_minor;
    ELSIF NEW.price_yearly_paise IS DISTINCT FROM OLD.price_yearly_paise THEN
      NEW.price_yearly_minor := NEW.price_yearly_paise;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_billing_plan_price_columns ON billing_plans;
CREATE TRIGGER trg_sync_billing_plan_price_columns
  BEFORE INSERT OR UPDATE ON billing_plans
  FOR EACH ROW EXECUTE FUNCTION sync_billing_plan_price_columns();

-- ── Published price book: one durable row per (plan, currency) ────────────────
-- Prices do NOT float with the FX market. A row is written once (either by an
-- admin or generated from FX on first use) and then stays put until it is
-- explicitly refreshed, so a customer never sees the price move between page
-- load and checkout.
--
-- Amounts are BIGINT, not INTEGER: a yearly price in a high-denomination
-- currency (IDR, VND, COP) overflows a 32-bit minor-unit amount.

CREATE TABLE IF NOT EXISTS billing_plan_prices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             UUID        NOT NULL REFERENCES billing_plans(id) ON DELETE CASCADE,
  currency            VARCHAR(3)  NOT NULL,
  price_monthly_minor BIGINT      NOT NULL DEFAULT 0,
  price_yearly_minor  BIGINT      NOT NULL DEFAULT 0,
  source              VARCHAR(20) NOT NULL DEFAULT 'fx',   -- 'manual' | 'fx' | 'base'
  fx_rate             NUMERIC(18, 8),
  fx_rate_at          TIMESTAMPTZ,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_billing_plan_prices_currency
  ON billing_plan_prices(currency) WHERE is_active = true;

COMMENT ON TABLE billing_plan_prices IS
  'Published local list prices per currency. Manual rows are authoritative; fx rows are generated from base_currency and then frozen.';
COMMENT ON COLUMN billing_plan_prices.source IS
  'manual = set by a superadmin (never auto-overwritten), fx = derived from base price, base = mirror of the plan base currency';

-- ── Provider price/plan IDs, keyed by currency ───────────────────────────────
-- Stripe Prices and Razorpay Plans are immutable and single-currency, so a plan
-- needs one provider object per (currency, interval).
--
-- "interval" is quoted throughout: it is a Postgres type keyword, and the bare
-- form is ambiguous next to a literal (INTERVAL '1 day').

CREATE TABLE IF NOT EXISTS billing_plan_provider_prices (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           UUID        NOT NULL REFERENCES billing_plans(id) ON DELETE CASCADE,
  provider          VARCHAR(20) NOT NULL,                 -- 'stripe' | 'razorpay'
  currency          VARCHAR(3)  NOT NULL,
  "interval"        VARCHAR(10) NOT NULL,                 -- 'monthly' | 'yearly'
  provider_price_id VARCHAR(120) NOT NULL,                -- Stripe price_… / Razorpay plan_…
  provider_product_id VARCHAR(120),
  unit_amount_minor BIGINT      NOT NULL,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, provider, currency, "interval")
);

CREATE INDEX IF NOT EXISTS idx_plan_provider_prices_lookup
  ON billing_plan_provider_prices(provider, provider_price_id);

COMMENT ON TABLE billing_plan_provider_prices IS
  'Maps (plan, provider, currency, interval) to the immutable Stripe Price / Razorpay Plan created for it';

-- Backfill from the legacy single-currency columns so existing subscriptions
-- keep resolving to their plan.
INSERT INTO billing_plan_provider_prices
  (plan_id, provider, currency, "interval", provider_price_id, provider_product_id, unit_amount_minor)
SELECT bp.id, 'stripe', COALESCE(NULLIF(lower(bp.stripe_currency), ''), 'usd'), 'monthly',
       bp.stripe_price_monthly_id, bp.stripe_product_id, bp.price_monthly_paise
  FROM billing_plans bp
 WHERE bp.stripe_price_monthly_id IS NOT NULL
ON CONFLICT (plan_id, provider, currency, "interval") DO NOTHING;

INSERT INTO billing_plan_provider_prices
  (plan_id, provider, currency, "interval", provider_price_id, provider_product_id, unit_amount_minor)
SELECT bp.id, 'stripe', COALESCE(NULLIF(lower(bp.stripe_currency), ''), 'usd'), 'yearly',
       bp.stripe_price_yearly_id, bp.stripe_product_id, bp.price_yearly_paise
  FROM billing_plans bp
 WHERE bp.stripe_price_yearly_id IS NOT NULL
ON CONFLICT (plan_id, provider, currency, "interval") DO NOTHING;

INSERT INTO billing_plan_provider_prices
  (plan_id, provider, currency, "interval", provider_price_id, unit_amount_minor)
SELECT bp.id, 'razorpay', COALESCE(NULLIF(lower(bp.razorpay_currency), ''), 'inr'), 'monthly',
       bp.razorpay_plan_monthly_id, bp.price_monthly_paise
  FROM billing_plans bp
 WHERE bp.razorpay_plan_monthly_id IS NOT NULL
ON CONFLICT (plan_id, provider, currency, "interval") DO NOTHING;

INSERT INTO billing_plan_provider_prices
  (plan_id, provider, currency, "interval", provider_price_id, unit_amount_minor)
SELECT bp.id, 'razorpay', COALESCE(NULLIF(lower(bp.razorpay_currency), ''), 'inr'), 'yearly',
       bp.razorpay_plan_yearly_id, bp.price_yearly_paise
  FROM billing_plans bp
 WHERE bp.razorpay_plan_yearly_id IS NOT NULL
ON CONFLICT (plan_id, provider, currency, "interval") DO NOTHING;

-- ── FX rates cache ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fx_rates (
  base_currency  VARCHAR(3)     NOT NULL DEFAULT 'usd',
  currency       VARCHAR(3)     NOT NULL,
  rate           NUMERIC(18, 8) NOT NULL,
  source         VARCHAR(40)    NOT NULL DEFAULT 'fallback',
  fetched_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (base_currency, currency)
);

COMMENT ON TABLE fx_rates IS
  'Cached FX rates used to derive local list prices from the base currency. Refreshed on a schedule, never read live during checkout.';

-- ── Currency on the customer-facing records ──────────────────────────────────

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_currency     VARCHAR(3),
  ADD COLUMN IF NOT EXISTS billing_country      VARCHAR(2),
  ADD COLUMN IF NOT EXISTS per_user_price_minor INTEGER;

COMMENT ON COLUMN workspaces.billing_currency IS
  'Currency this workspace is billed in. Set at first checkout and then sticky.';
COMMENT ON COLUMN workspaces.billing_country IS
  'ISO 3166-1 alpha-2 country used to pick the billing currency and payment provider';

UPDATE workspaces
   SET per_user_price_minor = per_user_price_paise
 WHERE per_user_price_minor IS NULL
   AND per_user_price_paise IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_workspace_seat_price_columns()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.per_user_price_minor IS NULL AND NEW.per_user_price_paise IS NOT NULL THEN
      NEW.per_user_price_minor := NEW.per_user_price_paise;
    ELSIF NEW.per_user_price_paise IS NULL AND NEW.per_user_price_minor IS NOT NULL THEN
      NEW.per_user_price_paise := NEW.per_user_price_minor;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.per_user_price_minor IS DISTINCT FROM OLD.per_user_price_minor THEN
      NEW.per_user_price_paise := NEW.per_user_price_minor;
    ELSIF NEW.per_user_price_paise IS DISTINCT FROM OLD.per_user_price_paise THEN
      NEW.per_user_price_minor := NEW.per_user_price_paise;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_workspace_seat_price_columns ON workspaces;
CREATE TRIGGER trg_sync_workspace_seat_price_columns
  BEFORE INSERT OR UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION sync_workspace_seat_price_columns();

-- ── Activation payments and mandate amounts ──────────────────────────────────

-- amount_paise is NOT NULL with no default; new code writes amount_minor only,
-- so this trigger has to fill the old column in.
CREATE OR REPLACE FUNCTION sync_activation_amount_columns()
RETURNS trigger AS $$
BEGIN
  IF NEW.amount_minor IS NULL AND NEW.amount_paise IS NOT NULL THEN
    NEW.amount_minor := NEW.amount_paise;
  ELSIF NEW.amount_paise IS NULL AND NEW.amount_minor IS NOT NULL THEN
    NEW.amount_paise := NEW.amount_minor;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('public.trial_signup_checkout_sessions') IS NOT NULL THEN
    ALTER TABLE trial_signup_checkout_sessions
      ADD COLUMN IF NOT EXISTS billing_country VARCHAR(2);
  END IF;

  IF to_regclass('public.user_activation_payments') IS NOT NULL THEN
    ALTER TABLE user_activation_payments
      ADD COLUMN IF NOT EXISTS amount_minor BIGINT,
      ADD COLUMN IF NOT EXISTS currency     VARCHAR(3) NOT NULL DEFAULT 'usd';

    UPDATE user_activation_payments
       SET amount_minor = amount_paise
     WHERE amount_minor IS NULL;

    DROP TRIGGER IF EXISTS trg_sync_activation_amount_columns ON user_activation_payments;
    CREATE TRIGGER trg_sync_activation_amount_columns
      BEFORE INSERT OR UPDATE ON user_activation_payments
      FOR EACH ROW EXECUTE FUNCTION sync_activation_amount_columns();
  END IF;
END $$;

ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS auth_amount_minor INTEGER,
  ADD COLUMN IF NOT EXISTS auth_currency     VARCHAR(3);

UPDATE workspace_subscriptions
   SET auth_amount_minor = auth_amount_paise
 WHERE auth_amount_minor IS NULL
   AND auth_amount_paise IS NOT NULL;

-- ── Default plans are authored in USD from here on ───────────────────────────

UPDATE billing_plans SET stripe_currency = 'usd' WHERE stripe_currency IS NULL OR stripe_currency = '';
