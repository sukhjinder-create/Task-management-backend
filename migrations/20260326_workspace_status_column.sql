-- Add status text column to workspaces (active | suspended | deleted)
-- Replaces boolean is_active for richer state management

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS status VARCHAR(20);

-- Backfill from is_active
UPDATE workspaces
  SET status = CASE WHEN is_active = true THEN 'active' ELSE 'suspended' END
  WHERE status IS NULL;

-- Default for future rows
ALTER TABLE workspaces
  ALTER COLUMN status SET DEFAULT 'active';
