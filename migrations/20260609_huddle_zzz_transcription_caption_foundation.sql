-- Huddle transcription and live captions foundation.
-- Additive and idempotent. No summaries, decisions, action items, memory promotion, or copilot.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_id_workspace
  ON huddle_sessions (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participants_id_session_workspace
  ON huddle_session_participants (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_devices_id_session_workspace
  ON huddle_participant_devices (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcript_segments_id_session_workspace
  ON huddle_transcript_segments (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_artifacts_id_session_workspace
  ON huddle_artifacts (id, session_id, workspace_id);

CREATE TABLE IF NOT EXISTS huddle_transcription_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'workspace',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider_name TEXT NOT NULL DEFAULT 'deepgram',
  require_consent BOOLEAN NOT NULL DEFAULT FALSE,
  host_controls_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  captions_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  transcript_artifacts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  default_language TEXT,
  retention_days INTEGER,
  policy_version INTEGER NOT NULL DEFAULT 1,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_transcription_policies_scope_check
    CHECK (scope IN ('workspace', 'session')),
  CONSTRAINT huddle_transcription_policies_provider_check
    CHECK (provider_name IN ('deepgram', 'openai', 'groq', 'assemblyai', 'livekit_native', 'mock')),
  CONSTRAINT huddle_transcription_policies_retention_check
    CHECK (retention_days IS NULL OR retention_days >= 0),
  CONSTRAINT huddle_transcription_policies_version_check
    CHECK (policy_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcription_workspace_policy
  ON huddle_transcription_policies (workspace_id)
  WHERE scope = 'workspace' AND session_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcription_session_policy
  ON huddle_transcription_policies (workspace_id, session_id)
  WHERE scope = 'session' AND session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS huddle_transcription_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  participant_device_id UUID REFERENCES huddle_participant_devices(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL,
  provider_session_id TEXT,
  transport TEXT NOT NULL DEFAULT 'provider_token_websocket',
  status TEXT NOT NULL DEFAULT 'pending',
  captions_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  transcript_artifacts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  consent_required BOOLEAN NOT NULL DEFAULT FALSE,
  consent_status TEXT NOT NULL DEFAULT 'not_required',
  policy_id UUID REFERENCES huddle_transcription_policies(id) ON DELETE SET NULL,
  language TEXT,
  model TEXT,
  token_expires_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  partial_segment_count INTEGER NOT NULL DEFAULT 0,
  final_segment_count INTEGER NOT NULL DEFAULT 0,
  retracted_segment_count INTEGER NOT NULL DEFAULT 0,
  caption_event_count INTEGER NOT NULL DEFAULT 0,
  attribution_count INTEGER NOT NULL DEFAULT 0,
  finalized_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_transcription_sessions_provider_check
    CHECK (provider_name IN ('deepgram', 'openai', 'groq', 'assemblyai', 'livekit_native', 'mock')),
  CONSTRAINT huddle_transcription_sessions_status_check
    CHECK (status IN ('pending', 'active', 'paused', 'finalizing', 'finalized', 'failed', 'cancelled')),
  CONSTRAINT huddle_transcription_sessions_consent_status_check
    CHECK (consent_status IN ('not_required', 'requested', 'granted', 'denied', 'revoked')),
  CONSTRAINT huddle_transcription_sessions_counts_check
    CHECK (
      partial_segment_count >= 0
      AND final_segment_count >= 0
      AND retracted_segment_count >= 0
      AND caption_event_count >= 0
      AND attribution_count >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_huddle_transcription_sessions_session_status
  ON huddle_transcription_sessions (workspace_id, session_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_transcription_sessions_participant
  ON huddle_transcription_sessions (workspace_id, session_id, participant_id, provider_name, updated_at DESC)
  WHERE participant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS huddle_transcription_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  transcription_session_id UUID REFERENCES huddle_transcription_sessions(id) ON DELETE SET NULL,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL,
  provider_event_id TEXT,
  provider_request_id TEXT,
  source_segment_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  caption_event_id UUID REFERENCES huddle_caption_events(id) ON DELETE SET NULL,
  speaker_attribution_id UUID REFERENCES huddle_speaker_attributions(id) ON DELETE SET NULL,
  transcript_text TEXT,
  language TEXT,
  confidence NUMERIC(5,4),
  sequence_number BIGINT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT huddle_transcription_provider_events_provider_check
    CHECK (provider_name IN ('deepgram', 'openai', 'groq', 'assemblyai', 'livekit_native', 'mock')),
  CONSTRAINT huddle_transcription_provider_events_type_check
    CHECK (event_type IN ('token_granted', 'partial', 'final', 'retracted', 'provider_error', 'session_started', 'session_finalized')),
  CONSTRAINT huddle_transcription_provider_events_status_check
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  CONSTRAINT huddle_transcription_provider_events_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcription_provider_event
  ON huddle_transcription_provider_events (workspace_id, session_id, provider_name, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_transcription_provider_events_session
  ON huddle_transcription_provider_events (workspace_id, session_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_transcription_provider_events_source
  ON huddle_transcription_provider_events (workspace_id, session_id, source_segment_id)
  WHERE source_segment_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcription_policies_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcription_policies
      ADD CONSTRAINT huddle_transcription_policies_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcription_sessions_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcription_sessions
      ADD CONSTRAINT huddle_transcription_sessions_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcription_sessions_participant_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcription_sessions
      ADD CONSTRAINT huddle_transcription_sessions_participant_workspace_fk
      FOREIGN KEY (participant_id, session_id, workspace_id)
      REFERENCES huddle_session_participants(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcription_sessions_device_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcription_sessions
      ADD CONSTRAINT huddle_transcription_sessions_device_workspace_fk
      FOREIGN KEY (participant_device_id, session_id, workspace_id)
      REFERENCES huddle_participant_devices(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcription_provider_events_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcription_provider_events
      ADD CONSTRAINT huddle_transcription_provider_events_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcription_provider_events_participant_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcription_provider_events
      ADD CONSTRAINT huddle_transcription_provider_events_participant_workspace_fk
      FOREIGN KEY (participant_id, session_id, workspace_id)
      REFERENCES huddle_session_participants(id, session_id, workspace_id)
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION touch_huddle_transcription_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS huddle_transcription_policies_touch_updated_at
  ON huddle_transcription_policies;
CREATE TRIGGER huddle_transcription_policies_touch_updated_at
  BEFORE UPDATE ON huddle_transcription_policies
  FOR EACH ROW
  EXECUTE FUNCTION touch_huddle_transcription_updated_at();

DROP TRIGGER IF EXISTS huddle_transcription_sessions_touch_updated_at
  ON huddle_transcription_sessions;
CREATE TRIGGER huddle_transcription_sessions_touch_updated_at
  BEFORE UPDATE ON huddle_transcription_sessions
  FOR EACH ROW
  EXECUTE FUNCTION touch_huddle_transcription_updated_at();
