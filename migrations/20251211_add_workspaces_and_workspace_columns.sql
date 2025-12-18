-- migrations/20251211_add_workspaces_and_workspace_columns.sql
-- Safe, idempotent migration to add workspaces & workspace_users + workspace_id columns
-- and enforce one user -> one workspace uniqueness.

-- 0) Ensure pgcrypto extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Create workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE,
  billing_plan text NULL,
  max_members integer DEFAULT 10,
  created_by uuid NULL,
  metadata jsonb NULL,
  created_at timestamptz DEFAULT now()
);

-- 2) Create workspace_users linking table
CREATE TABLE IF NOT EXISTS workspace_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  created_at timestamptz DEFAULT now()
);

-- 3) Create indexes on workspace_users for fast lookup
CREATE INDEX IF NOT EXISTS idx_workspace_users_workspace_id ON workspace_users (workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_users_user_id ON workspace_users (user_id);

-- 4) Add workspace_id columns to existing tables (nullable, non-breaking)
ALTER TABLE IF EXISTS chat_channels
  ADD COLUMN IF NOT EXISTS workspace_id uuid NULL;

ALTER TABLE IF EXISTS chat_channel_members
  ADD COLUMN IF NOT EXISTS workspace_id uuid NULL;

ALTER TABLE IF EXISTS chat_channel_admins
  ADD COLUMN IF NOT EXISTS workspace_id uuid NULL;

ALTER TABLE IF EXISTS chat_messages
  ADD COLUMN IF NOT EXISTS workspace_id uuid NULL;

ALTER TABLE IF EXISTS projects
  ADD COLUMN IF NOT EXISTS workspace_id uuid NULL;

ALTER TABLE IF EXISTS tasks
  ADD COLUMN IF NOT EXISTS workspace_id uuid NULL;

-- 5) Indexes for workspace-related queries
CREATE INDEX IF NOT EXISTS idx_chat_channels_workspace_id ON chat_channels (workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_workspace_id ON chat_messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects (workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks (workspace_id);

-- 6) ENFORCE ONE ACCOUNT → ONE WORKSPACE (unique constraint on workspace_users.user_id)
-- First: check duplicates (run manually, see note below)
-- SELECT user_id, array_agg(workspace_id) AS workspaces, count(*) AS cnt
-- FROM workspace_users
-- GROUP BY user_id
-- HAVING count(*) > 1;

-- If duplicates exist, resolve them manually (you can keep earliest created membership).
-- After duplicates are gone, create unique index. Use CONCURRENTLY for minimal locking.

-- Create unique index on user_id (concurrent recommended; must be run outside transaction)
-- If your DB supports it, run this as a separate statement (not inside a transaction).
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_users_user_id_unique
  ON workspace_users (user_id);

-- 001_create_workspaces.sql
-- Create workspaces table (multi-tenant container)
CREATE TABLE IF NOT EXISTS workspaces (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  plan_id BIGINT NULL,
  owner_user_id BIGINT NULL,             -- optional: primary workspace owner
  created_by BIGINT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- uniqueness & lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces (LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_user_id ON workspaces (owner_user_id);
