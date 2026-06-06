-- Workspace-native Huddle session model.
-- Additive and idempotent: legacy chat_huddles remains the compatibility source.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS huddle_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  legacy_huddle_id TEXT,
  legacy_channel_key TEXT,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  channel_id UUID REFERENCES chat_channels(id) ON DELETE SET NULL,
  thread_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
  started_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'live',
  mode TEXT NOT NULL DEFAULT 'audio_video',
  visibility TEXT NOT NULL DEFAULT 'workspace',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  ended_by UUID REFERENCES users(id) ON DELETE SET NULL,
  end_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_sessions_scope_type_check
    CHECK (scope_type IN ('workspace', 'channel', 'dm', 'thread', 'task', 'project', 'incident', 'external_guest_room', 'scheduled_meeting', 'ad_hoc')),
  CONSTRAINT huddle_sessions_state_check
    CHECK (state IN ('draft', 'scheduled', 'starting', 'ringing', 'live', 'degraded', 'reconnecting', 'paused', 'ending', 'ended', 'failed', 'archived')),
  CONSTRAINT huddle_sessions_mode_check
    CHECK (mode IN ('audio', 'video', 'audio_video', 'screen_share', 'collaboration', 'broadcast')),
  CONSTRAINT huddle_sessions_visibility_check
    CHECK (visibility IN ('workspace', 'scope_members', 'session_participants', 'private', 'guest_enabled'))
);

CREATE TABLE IF NOT EXISTS huddle_guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  email TEXT,
  external_id TEXT,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT huddle_guests_status_check
    CHECK (status IN ('invited', 'active', 'revoked', 'expired'))
);

CREATE TABLE IF NOT EXISTS huddle_session_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  participant_kind TEXT NOT NULL DEFAULT 'workspace_user',
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'participant',
  invite_state TEXT NOT NULL DEFAULT 'none',
  join_state TEXT NOT NULL DEFAULT 'invited',
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_participants_kind_check
    CHECK (participant_kind IN ('workspace_user', 'guest', 'ai_agent', 'system')),
  CONSTRAINT huddle_participants_role_check
    CHECK (role IN ('host', 'co_host', 'participant', 'guest', 'listener', 'recorder', 'ai_agent', 'system')),
  CONSTRAINT huddle_participants_invite_state_check
    CHECK (invite_state IN ('none', 'invited', 'ringing', 'accepted', 'declined', 'missed', 'revoked')),
  CONSTRAINT huddle_participants_join_state_check
    CHECK (join_state IN ('invited', 'joining', 'joined', 'reconnecting', 'left', 'removed', 'declined')),
  CONSTRAINT huddle_participants_identity_check
    CHECK (
      (participant_kind = 'workspace_user' AND user_id IS NOT NULL AND guest_id IS NULL)
      OR (participant_kind = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL)
      OR participant_kind IN ('ai_agent', 'system')
    )
);

CREATE TABLE IF NOT EXISTS huddle_participant_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES huddle_session_participants(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  socket_id TEXT,
  device_id TEXT,
  platform TEXT,
  device_label TEXT,
  join_state TEXT NOT NULL DEFAULT 'joined',
  media_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_devices_join_state_check
    CHECK (join_state IN ('joining', 'joined', 'reconnecting', 'left', 'removed'))
);

CREATE TABLE IF NOT EXISTS huddle_session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS huddle_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  source_event_id UUID REFERENCES huddle_session_events(id) ON DELETE SET NULL,
  storage_provider TEXT,
  storage_key TEXT,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_text TEXT,
  visibility TEXT NOT NULL DEFAULT 'session_participants',
  retention_policy TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT huddle_artifacts_type_check
    CHECK (artifact_type IN ('recording', 'transcript', 'summary', 'decision', 'action_item', 'ai_memory', 'task_link', 'chat_follow_up', 'quality_report', 'compliance_export')),
  CONSTRAINT huddle_artifacts_status_check
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'deleted')),
  CONSTRAINT huddle_artifacts_visibility_check
    CHECK (visibility IN ('session_participants', 'scope_members', 'workspace_admins', 'private'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_active_scope
  ON huddle_sessions (workspace_id, scope_type, scope_key)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_legacy_huddle
  ON huddle_sessions (workspace_id, legacy_huddle_id)
  WHERE legacy_huddle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_sessions_legacy_channel_active
  ON huddle_sessions (workspace_id, legacy_channel_key)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_sessions_workspace_state
  ON huddle_sessions (workspace_id, state, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_sessions_started_by
  ON huddle_sessions (workspace_id, started_by, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_guests_workspace_email
  ON huddle_guests (workspace_id, email);

CREATE INDEX IF NOT EXISTS idx_huddle_guests_expires
  ON huddle_guests (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participants_user
  ON huddle_session_participants (session_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participants_guest
  ON huddle_session_participants (session_id, guest_id)
  WHERE guest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_participants_session_state
  ON huddle_session_participants (session_id, join_state);

CREATE INDEX IF NOT EXISTS idx_huddle_participants_workspace_user
  ON huddle_session_participants (workspace_id, user_id);

CREATE INDEX IF NOT EXISTS idx_huddle_participants_workspace_guest
  ON huddle_session_participants (workspace_id, guest_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_devices_active_socket
  ON huddle_participant_devices (session_id, participant_id, socket_id)
  WHERE socket_id IS NOT NULL AND left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_devices_participant_state
  ON huddle_participant_devices (participant_id, join_state);

CREATE INDEX IF NOT EXISTS idx_huddle_devices_session_state
  ON huddle_participant_devices (session_id, join_state);

CREATE INDEX IF NOT EXISTS idx_huddle_devices_workspace_user
  ON huddle_participant_devices (workspace_id, user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_events_session_created
  ON huddle_session_events (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_huddle_events_workspace_type_created
  ON huddle_session_events (workspace_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_artifacts_session_type
  ON huddle_artifacts (workspace_id, session_id, artifact_type);

CREATE INDEX IF NOT EXISTS idx_huddle_artifacts_workspace_type_created
  ON huddle_artifacts (workspace_id, artifact_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_artifacts_search
  ON huddle_artifacts USING gin (to_tsvector('simple', COALESCE(content_text, '')))
  WHERE content_text IS NOT NULL AND deleted_at IS NULL;
