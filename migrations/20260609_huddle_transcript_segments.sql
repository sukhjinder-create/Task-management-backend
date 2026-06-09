-- Phase 1 Huddle Intelligence foundation: canonical transcript segments.
-- Additive and idempotent. No AI generation, captions, or media behavior changes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Composite uniqueness is required for workspace-consistent foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_id_workspace
  ON huddle_sessions (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participants_id_session_workspace
  ON huddle_session_participants (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_events_id_session_workspace
  ON huddle_session_events (id, session_id, workspace_id);

CREATE TABLE IF NOT EXISTS huddle_transcript_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  participant_device_id UUID REFERENCES huddle_participant_devices(id) ON DELETE SET NULL,
  speaker_kind TEXT NOT NULL DEFAULT 'unknown',
  speaker_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  speaker_guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  speaker_label TEXT,
  source_provider TEXT NOT NULL DEFAULT 'unknown',
  source_segment_id TEXT,
  source_event_id UUID REFERENCES huddle_session_events(id) ON DELETE SET NULL,
  language TEXT,
  transcript_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'partial',
  confidence NUMERIC(5,4),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  sequence_number BIGINT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT huddle_transcript_segments_status_check
    CHECK (status IN ('partial', 'final', 'retracted')),
  CONSTRAINT huddle_transcript_segments_speaker_kind_check
    CHECK (speaker_kind IN ('workspace_user', 'guest', 'ai_agent', 'system', 'unknown')),
  CONSTRAINT huddle_transcript_segments_speaker_identity_check
    CHECK (speaker_user_id IS NULL OR speaker_guest_id IS NULL),
  CONSTRAINT huddle_transcript_segments_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT huddle_transcript_segments_timing_check
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT huddle_transcript_segments_finalized_check
    CHECK (
      (status = 'final' AND finalized_at IS NOT NULL)
      OR (status != 'final')
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcript_segments_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcript_segments
      ADD CONSTRAINT huddle_transcript_segments_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcript_segments_participant_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcript_segments
      ADD CONSTRAINT huddle_transcript_segments_participant_session_workspace_fk
      FOREIGN KEY (participant_id, session_id, workspace_id)
      REFERENCES huddle_session_participants(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_transcript_segments_source_event_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_transcript_segments
      ADD CONSTRAINT huddle_transcript_segments_source_event_session_workspace_fk
      FOREIGN KEY (source_event_id, session_id, workspace_id)
      REFERENCES huddle_session_events(id, session_id, workspace_id)
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_huddle_transcript_segments_session_time
  ON huddle_transcript_segments (workspace_id, session_id, started_at, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_transcript_segments_session_status
  ON huddle_transcript_segments (workspace_id, session_id, status, started_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_transcript_segments_participant
  ON huddle_transcript_segments (workspace_id, participant_id, started_at)
  WHERE participant_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_transcript_segments_speaker_user
  ON huddle_transcript_segments (workspace_id, speaker_user_id, started_at)
  WHERE speaker_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcript_segments_source
  ON huddle_transcript_segments (workspace_id, session_id, source_provider, source_segment_id)
  WHERE source_segment_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_transcript_segments_search
  ON huddle_transcript_segments USING gin (to_tsvector('simple', COALESCE(transcript_text, '')))
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION validate_huddle_transcript_segment_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM huddle_sessions s
    WHERE s.id = NEW.session_id
      AND s.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Transcript segment session ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.participant_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_session_participants p
       WHERE p.id = NEW.participant_id
         AND p.session_id = NEW.session_id
         AND p.workspace_id = NEW.workspace_id
     ) THEN
    RAISE EXCEPTION 'Transcript segment participant ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.participant_device_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_participant_devices d
       WHERE d.id = NEW.participant_device_id
         AND d.session_id = NEW.session_id
         AND d.workspace_id = NEW.workspace_id
         AND (
           NEW.participant_id IS NULL
           OR d.participant_id = NEW.participant_id
         )
     ) THEN
    RAISE EXCEPTION 'Transcript segment device ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.source_event_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_session_events e
       WHERE e.id = NEW.source_event_id
         AND e.session_id = NEW.session_id
         AND e.workspace_id = NEW.workspace_id
     ) THEN
    RAISE EXCEPTION 'Transcript segment source event ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.speaker_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.speaker_user_id
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Transcript segment speaker user does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.speaker_guest_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_guests g
       WHERE g.id = NEW.speaker_guest_id
         AND g.workspace_id = NEW.workspace_id
     ) THEN
    RAISE EXCEPTION 'Transcript segment speaker guest does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION touch_huddle_transcript_segment_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.revision = COALESCE(OLD.revision, 0) + 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS huddle_transcript_segments_validate_ownership
  ON huddle_transcript_segments;
CREATE TRIGGER huddle_transcript_segments_validate_ownership
  BEFORE INSERT OR UPDATE OF session_id, workspace_id, participant_id, participant_device_id, source_event_id, speaker_user_id, speaker_guest_id
  ON huddle_transcript_segments
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_transcript_segment_ownership();

DROP TRIGGER IF EXISTS huddle_transcript_segments_touch_updated_at
  ON huddle_transcript_segments;
CREATE TRIGGER huddle_transcript_segments_touch_updated_at
  BEFORE UPDATE
  ON huddle_transcript_segments
  FOR EACH ROW
  EXECUTE FUNCTION touch_huddle_transcript_segment_updated_at();

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT *
    FROM (
      VALUES
        ('huddle_transcript_segments', 'huddle_transcript_segments_session_workspace_fk'),
        ('huddle_transcript_segments', 'huddle_transcript_segments_participant_session_workspace_fk'),
        ('huddle_transcript_segments', 'huddle_transcript_segments_source_event_session_workspace_fk')
    ) AS constraints_to_validate(table_name, constraint_name)
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        item.table_name,
        item.constraint_name
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Huddle transcript constraint % on % remains NOT VALID: %',
        item.constraint_name,
        item.table_name,
        SQLERRM;
    END;
  END LOOP;
END $$;
