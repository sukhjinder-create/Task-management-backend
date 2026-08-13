-- No-card self-serve trial lifecycle.
-- The trial intent is stored in the existing workspaces.metadata JSONB column;
-- this partial index keeps expiry reconciliation bounded as the tenant count grows.

CREATE INDEX IF NOT EXISTS idx_workspaces_unpaid_trial_expiry
  ON workspaces (trial_ends_at)
  WHERE trial_ends_at IS NOT NULL AND billing_plan IS NULL;

COMMENT ON INDEX idx_workspaces_unpaid_trial_expiry IS
  'Supports idempotent downgrade of expired no-card trials to the free fallback plan';
