-- Durable production call-delivery trace for Huddle start, invite, answer,
-- LiveKit token, room connection, and media-connected milestones.
-- Additive/idempotent and intentionally separate from lifecycle authority.

CREATE TABLE IF NOT EXISTS huddle_call_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NULL,
  session_id UUID NULL,
  huddle_id TEXT NOT NULL,
  channel_id TEXT NULL,
  actor_user_id UUID NULL,
  target_user_id UUID NULL,
  device_id TEXT NULL,
  platform TEXT NULL,
  client_surface TEXT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'observed',
  reason TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE huddle_call_delivery_events
  ADD COLUMN IF NOT EXISTS workspace_id UUID NULL,
  ADD COLUMN IF NOT EXISTS session_id UUID NULL,
  ADD COLUMN IF NOT EXISTS huddle_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS actor_user_id UUID NULL,
  ADD COLUMN IF NOT EXISTS target_user_id UUID NULL,
  ADD COLUMN IF NOT EXISTS device_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS platform TEXT NULL,
  ADD COLUMN IF NOT EXISTS client_surface TEXT NULL,
  ADD COLUMN IF NOT EXISTS step TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'observed',
  ADD COLUMN IF NOT EXISTS reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'huddle_call_delivery_events_workspace_fkey'
  ) THEN
    ALTER TABLE huddle_call_delivery_events
      ADD CONSTRAINT huddle_call_delivery_events_workspace_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'huddle_call_delivery_events_session_fkey'
  ) THEN
    ALTER TABLE huddle_call_delivery_events
      ADD CONSTRAINT huddle_call_delivery_events_session_fkey
      FOREIGN KEY (session_id) REFERENCES huddle_sessions(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'huddle_call_delivery_events_step_check'
  ) THEN
    ALTER TABLE huddle_call_delivery_events
      ADD CONSTRAINT huddle_call_delivery_events_step_check
      CHECK (
        step IN (
          'call_started',
          'incoming_call_delivered',
          'incoming_call_displayed',
          'answer_pressed',
          'decline_pressed',
          'join_request_sent',
          'join_request_received',
          'provider_lock_resolved',
          'session_resolved',
          'token_requested',
          'token_issued',
          'room_connect_started',
          'room_connect_success',
          'room_connect_failed',
          'audio_connected',
          'video_connected'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'huddle_call_delivery_events_status_check'
  ) THEN
    ALTER TABLE huddle_call_delivery_events
      ADD CONSTRAINT huddle_call_delivery_events_status_check
      CHECK (status IN ('observed', 'attempted', 'success', 'failure'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_huddle_call_delivery_workspace_huddle
  ON huddle_call_delivery_events (workspace_id, huddle_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_call_delivery_session
  ON huddle_call_delivery_events (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_call_delivery_step
  ON huddle_call_delivery_events (step, occurred_at DESC);
