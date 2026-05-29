-- Scope usernames to a workspace so separate tenants can use the same display name.
-- Keep email globally unique for login identity.

CREATE UNIQUE INDEX IF NOT EXISTS users_workspace_username_key
  ON users (workspace_id, username)
  WHERE workspace_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_global_username_key
  ON users (username)
  WHERE workspace_id IS NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_username_key;
