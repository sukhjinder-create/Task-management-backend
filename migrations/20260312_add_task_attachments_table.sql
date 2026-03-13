-- Migration: Create task_attachments table
-- Date: 2026-03-12

CREATE TABLE IF NOT EXISTS task_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id    UUID REFERENCES comments(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT,
  file_size     BIGINT,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id  TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Add comment_id column if table already exists without it
ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS comment_id UUID REFERENCES comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id   ON task_attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attachments_comment_id ON task_attachments(comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_attachments_workspace  ON task_attachments(workspace_id);
