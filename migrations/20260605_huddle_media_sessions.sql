-- Epic 5C Foundation: provider-neutral Huddle media-session persistence.
-- Additive and idempotent. Mesh remains the only active media provider.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS huddle_media_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL DEFAULT 'mesh',
  provider_room_id TEXT NOT NULL,
  provider_room_sid TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  selected_by TEXT NOT NULL DEFAULT 'provider_selector',
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  provisioned_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_media_sessions_provider_check
    CHECK (provider_type IN ('mesh', 'livekit')),
  CONSTRAINT huddle_media_sessions_state_check
    CHECK (state IN ('pending', 'active', 'degraded', 'ended', 'failed')),
  CONSTRAINT huddle_media_sessions_room_nonempty_check
    CHECK (length(trim(provider_room_id)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_media_sessions_session_provider
  ON huddle_media_sessions (session_id, provider_type);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_media_sessions_id_session_workspace
  ON huddle_media_sessions (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_media_sessions_room
  ON huddle_media_sessions (workspace_id, provider_type, provider_room_id);

CREATE INDEX IF NOT EXISTS idx_huddle_media_sessions_workspace_state
  ON huddle_media_sessions (workspace_id, provider_type, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_media_sessions_session
  ON huddle_media_sessions (session_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_devices_id_session_workspace
  ON huddle_participant_devices (id, session_id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_media_sessions_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_media_sessions
      ADD CONSTRAINT huddle_media_sessions_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS huddle_media_provider_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  media_session_id UUID NOT NULL REFERENCES huddle_media_sessions(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  device_id UUID REFERENCES huddle_participant_devices(id) ON DELETE SET NULL,
  provider_type TEXT NOT NULL DEFAULT 'mesh',
  provider_identity TEXT NOT NULL,
  provider_participant_sid TEXT,
  identity_kind TEXT NOT NULL DEFAULT 'workspace_user',
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_media_identities_provider_check
    CHECK (provider_type IN ('mesh', 'livekit')),
  CONSTRAINT huddle_media_identities_kind_check
    CHECK (identity_kind IN ('workspace_user', 'guest', 'ai_agent', 'system')),
  CONSTRAINT huddle_media_identities_state_check
    CHECK (state IN ('active', 'inactive', 'revoked')),
  CONSTRAINT huddle_media_identities_identity_check
    CHECK (
      (identity_kind = 'workspace_user' AND user_id IS NOT NULL AND guest_id IS NULL)
      OR (identity_kind = 'guest' AND guest_id IS NOT NULL AND user_id IS NULL)
      OR identity_kind IN ('ai_agent', 'system')
    ),
  CONSTRAINT huddle_media_identities_provider_identity_nonempty_check
    CHECK (length(trim(provider_identity)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_media_identities_provider_identity
  ON huddle_media_provider_identities (
    workspace_id,
    provider_type,
    provider_identity
  )
  WHERE state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_media_identities_device_provider
  ON huddle_media_provider_identities (
    media_session_id,
    device_id,
    provider_type
  )
  WHERE device_id IS NOT NULL AND state = 'active';

CREATE INDEX IF NOT EXISTS idx_huddle_media_identities_session
  ON huddle_media_provider_identities (workspace_id, session_id, state);

CREATE INDEX IF NOT EXISTS idx_huddle_media_identities_participant
  ON huddle_media_provider_identities (participant_id, state)
  WHERE participant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_media_identities_device
  ON huddle_media_provider_identities (device_id, state)
  WHERE device_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_media_identities_media_session_fk'
  ) THEN
    ALTER TABLE huddle_media_provider_identities
      ADD CONSTRAINT huddle_media_identities_media_session_fk
      FOREIGN KEY (media_session_id, session_id, workspace_id)
      REFERENCES huddle_media_sessions(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_media_identities_participant_fk'
  ) THEN
    ALTER TABLE huddle_media_provider_identities
      ADD CONSTRAINT huddle_media_identities_participant_fk
      FOREIGN KEY (participant_id, session_id, workspace_id)
      REFERENCES huddle_session_participants(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_media_identities_device_fk'
  ) THEN
    ALTER TABLE huddle_media_provider_identities
      ADD CONSTRAINT huddle_media_identities_device_fk
      FOREIGN KEY (device_id, session_id, workspace_id)
      REFERENCES huddle_participant_devices(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_media_identities_guest_workspace_fk'
  ) THEN
    ALTER TABLE huddle_media_provider_identities
      ADD CONSTRAINT huddle_media_identities_guest_workspace_fk
      FOREIGN KEY (guest_id, workspace_id)
      REFERENCES huddle_guests(id, workspace_id)
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_media_identity_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.media_session_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_media_sessions ms
       WHERE ms.id = NEW.media_session_id
         AND ms.session_id = NEW.session_id
         AND ms.workspace_id = NEW.workspace_id
         AND ms.provider_type = NEW.provider_type
     ) THEN
    RAISE EXCEPTION 'Huddle media identity media-session ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.participant_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_session_participants p
       WHERE p.id = NEW.participant_id
         AND p.session_id = NEW.session_id
         AND p.workspace_id = NEW.workspace_id
         AND p.user_id IS NOT DISTINCT FROM NEW.user_id
         AND p.guest_id IS NOT DISTINCT FROM NEW.guest_id
     ) THEN
    RAISE EXCEPTION 'Huddle media identity participant ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.device_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_participant_devices d
       WHERE d.id = NEW.device_id
         AND d.session_id = NEW.session_id
         AND d.workspace_id = NEW.workspace_id
         AND d.user_id IS NOT DISTINCT FROM NEW.user_id
         AND d.guest_id IS NOT DISTINCT FROM NEW.guest_id
     ) THEN
    RAISE EXCEPTION 'Huddle media identity device ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS huddle_media_identities_validate_ownership
  ON huddle_media_provider_identities;
CREATE TRIGGER huddle_media_identities_validate_ownership
  BEFORE INSERT OR UPDATE OF
    workspace_id,
    media_session_id,
    session_id,
    participant_id,
    device_id,
    provider_type,
    user_id,
    guest_id
  ON huddle_media_provider_identities
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_media_identity_ownership();
