-- Epic 4F: additive restoration-readiness hardening.
-- This does not restore participants/devices; it only adds durable identity,
-- fencing, and idempotency primitives for future controlled restoration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE huddle_participant_devices
  ADD COLUMN IF NOT EXISTS logical_device_id TEXT,
  ADD COLUMN IF NOT EXISTS recovery_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_session_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS restore_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_devices_active_logical_device
  ON huddle_participant_devices (session_id, participant_id, logical_device_id)
  WHERE logical_device_id IS NOT NULL AND left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_devices_logical_workspace
  ON huddle_participant_devices (workspace_id, user_id, logical_device_id, last_seen_at DESC)
  WHERE logical_device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS huddle_recovery_fences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  huddle_id TEXT NOT NULL,
  channel_id TEXT,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  identity_kind TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  guest_id UUID REFERENCES huddle_guests(id) ON DELETE CASCADE,
  logical_device_id TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0,
  session_version BIGINT NOT NULL DEFAULT 0,
  last_snapshot_id TEXT,
  last_idempotency_key TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT huddle_recovery_fences_identity_kind_check
    CHECK (identity_kind IN ('user', 'guest', 'anonymous')),
  CONSTRAINT huddle_recovery_fences_identity_check
    CHECK (
      (identity_kind = 'user' AND user_id IS NOT NULL AND guest_id IS NULL)
      OR (identity_kind = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL)
      OR (identity_kind = 'anonymous')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_recovery_fences_identity
  ON huddle_recovery_fences (
    workspace_id,
    huddle_id,
    identity_kind,
    identity_id,
    logical_device_id
  );

CREATE INDEX IF NOT EXISTS idx_huddle_recovery_fences_session
  ON huddle_recovery_fences (workspace_id, session_id, updated_at DESC)
  WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS huddle_restore_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  huddle_id TEXT NOT NULL,
  channel_id TEXT,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  identity_kind TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  guest_id UUID REFERENCES huddle_guests(id) ON DELETE CASCADE,
  logical_device_id TEXT NOT NULL,
  snapshot_id TEXT,
  generation BIGINT NOT NULL DEFAULT 0,
  session_version BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'validated',
  decision_reason TEXT,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT huddle_restore_attempts_status_check
    CHECK (status IN ('validated', 'rejected', 'consumed')),
  CONSTRAINT huddle_restore_attempts_identity_kind_check
    CHECK (identity_kind IN ('user', 'guest', 'anonymous')),
  CONSTRAINT huddle_restore_attempts_identity_check
    CHECK (
      (identity_kind = 'user' AND user_id IS NOT NULL AND guest_id IS NULL)
      OR (identity_kind = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL)
      OR (identity_kind = 'anonymous')
    )
);

CREATE INDEX IF NOT EXISTS idx_huddle_restore_attempts_session
  ON huddle_restore_attempts (workspace_id, session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_restore_attempts_identity
  ON huddle_restore_attempts (
    workspace_id,
    huddle_id,
    identity_kind,
    identity_id,
    logical_device_id,
    created_at DESC
  );
