-- Ensure notifications table exists with all required columns
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT        NOT NULL,
  message      TEXT        NOT NULL,
  task_id      UUID        REFERENCES tasks(id) ON DELETE SET NULL,
  project_id   UUID        REFERENCES projects(id) ON DELETE SET NULL,
  comment_id   UUID        REFERENCES comments(id) ON DELETE SET NULL,
  workspace_id UUID        REFERENCES workspaces(id) ON DELETE CASCADE,
  is_read      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id       ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace_id  ON notifications(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread        ON notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created_at    ON notifications(created_at DESC);
