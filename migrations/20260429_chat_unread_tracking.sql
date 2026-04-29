-- Track per-user, per-channel read position for unread count badges
CREATE TABLE IF NOT EXISTS chat_channel_read_status (
  user_id     UUID         NOT NULL,
  channel_key VARCHAR(500) NOT NULL,
  workspace_id UUID,
  last_read_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_key)
);
CREATE INDEX IF NOT EXISTS idx_ccrs_user ON chat_channel_read_status(user_id);
