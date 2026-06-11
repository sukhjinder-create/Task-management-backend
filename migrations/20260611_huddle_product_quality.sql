-- Huddle product-quality milestone.
-- Additive persistence for Meeting Intelligence delivery and LiveKit quality samples.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS action_url TEXT,
  ADD COLUMN IF NOT EXISTS source_key TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_user_source_key
  ON notifications (user_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS huddle_media_quality_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  media_session_id UUID REFERENCES huddle_media_sessions(id) ON DELETE SET NULL,
  provider_identity_id UUID REFERENCES huddle_media_provider_identities(id) ON DELETE SET NULL,
  provider_type TEXT NOT NULL DEFAULT 'livekit',
  provider_room_id TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  aggregate JSONB NOT NULL DEFAULT '{}'::jsonb,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
  browser JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_media_quality_samples_provider_check
    CHECK (provider_type IN ('mesh', 'livekit'))
);

CREATE INDEX IF NOT EXISTS idx_huddle_media_quality_samples_session
  ON huddle_media_quality_samples (workspace_id, session_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_media_quality_samples_track_analysis
  ON huddle_media_quality_samples (workspace_id, provider_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_media_quality_samples_screen_share
  ON huddle_media_quality_samples (workspace_id, session_id, observed_at DESC)
  WHERE (aggregate->>'screenShareTrackCount')::integer > 0;

