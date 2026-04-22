-- Push notification tokens (web VAPID subscriptions + FCM tokens)
CREATE TABLE IF NOT EXISTS user_push_tokens (
  id           SERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT,
  platform     TEXT NOT NULL DEFAULT 'web', -- 'web' | 'android' | 'ios'
  -- Web push VAPID subscription fields
  endpoint     TEXT,
  keys_p256dh  TEXT,
  keys_auth    TEXT,
  -- FCM token (Android/iOS)
  fcm_token    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_push_tokens_unique
  ON user_push_tokens (user_id, COALESCE(endpoint, ''), COALESCE(fcm_token, ''));

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON user_push_tokens(user_id);

-- Notification preferences per user
CREATE TABLE IF NOT EXISTS notification_preferences (
  id           SERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  mute_all     BOOLEAN NOT NULL DEFAULT false,
  mute_tasks   BOOLEAN NOT NULL DEFAULT false,
  mute_chat    BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id ON notification_preferences(user_id);
