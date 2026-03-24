-- Reviews Automation: manager hierarchy + cycle automation columns
-- Run once; all statements are idempotent.

-- 1. Manager relationship on workspace_users
--    Lets admins configure who reports to whom; drives auto-assigned manager reviews.
ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- 2. Automation metadata on review_cycles
ALTER TABLE review_cycles
  ADD COLUMN IF NOT EXISTS auto_generated    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS peer_review_count integer DEFAULT 2,
  ADD COLUMN IF NOT EXISTS reminder_sent_7d  boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_sent_1d  boolean DEFAULT false;

-- 3. Index for efficient cron queries (status + date range lookups)
CREATE INDEX IF NOT EXISTS idx_review_cycles_cron
  ON review_cycles(status, start_date, end_date);

-- 4. Index for manager lookups
CREATE INDEX IF NOT EXISTS idx_workspace_users_manager
  ON workspace_users(workspace_id, manager_id)
  WHERE manager_id IS NOT NULL;
