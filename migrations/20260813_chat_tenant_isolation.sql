-- Tenant-safe unread state. Message and channel reads already carry workspace_id;
-- read markers now retain the same boundary so identical system-channel keys
-- cannot share state across workspaces.
BEGIN;

ALTER TABLE chat_channel_read_status
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

UPDATE chat_channel_read_status rs
SET workspace_id = u.workspace_id
FROM users u
WHERE rs.user_id = u.id
  AND rs.workspace_id IS NULL
  AND u.workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ccrs_workspace_user
  ON chat_channel_read_status (workspace_id, user_id);

COMMIT;
