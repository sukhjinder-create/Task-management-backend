-- =============================================================================
-- USER BILLING STATUS — Per-user per-month licensing model
-- Trial: 7 days from workspace creation, limits: 1 admin, 2 managers, 10 users
-- After trial / subscription: new users are 'pending' until admin pays for them
-- =============================================================================

-- ── workspace_users: billing status per user ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'workspace_users'
      AND column_name = 'billing_status'
  ) THEN
    ALTER TABLE workspace_users
      ADD COLUMN billing_status VARCHAR(20) NOT NULL DEFAULT 'active';
  END IF;
END $$;

ALTER TABLE workspace_users
  ALTER COLUMN billing_status SET DEFAULT 'pending';

ALTER TABLE workspace_users
  DROP CONSTRAINT IF EXISTS workspace_users_billing_status_check;

ALTER TABLE workspace_users
  ADD CONSTRAINT workspace_users_billing_status_check
  CHECK (billing_status IN ('trial', 'active', 'pending'));

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS cycle_start TIMESTAMPTZ;

ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS cycle_end TIMESTAMPTZ;

UPDATE workspace_users
  SET activated_at = NOW()
  WHERE billing_status = 'active'
    AND activated_at IS NULL;

-- ── workspaces: trial + billing cycle fields ──────────────────────────────────
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_cycle_anchor TIMESTAMPTZ;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS per_user_price_paise INTEGER;

-- Backfill trial_started_at for existing workspaces (use created_at as anchor)
UPDATE workspaces
  SET trial_started_at = created_at
  WHERE trial_started_at IS NULL AND created_at IS NOT NULL;

UPDATE workspaces
  SET trial_started_at = NOW()
  WHERE trial_started_at IS NULL;

-- ── User activation payments log ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_activation_payments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_ids            UUID[]      NOT NULL,
  amount_paise        INTEGER     NOT NULL,
  provider            TEXT        NOT NULL DEFAULT 'stripe',
  checkout_session_id TEXT,
  payment_intent_id   TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'created',
  pro_rated_days      INTEGER,
  cycle_start         TIMESTAMPTZ,
  cycle_end           TIMESTAMPTZ,
  created_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_activation_payments_status_check
    CHECK (status IN ('created', 'paid', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_user_activation_payments_workspace
  ON user_activation_payments(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_users_billing_status
  ON workspace_users(workspace_id, billing_status);
