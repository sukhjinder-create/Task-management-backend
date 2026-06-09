-- Huddle Intelligence Core architecture.
-- Additive and idempotent. This creates orchestration contracts only:
-- no AI generation, STT provider, captions UI, memory promotion, or task creation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_id_workspace
  ON huddle_sessions (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participants_id_session_workspace
  ON huddle_session_participants (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_devices_id_session_workspace
  ON huddle_participant_devices (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_events_id_session_workspace
  ON huddle_session_events (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_artifacts_id_session_workspace
  ON huddle_artifacts (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcript_segments_id_session_workspace
  ON huddle_transcript_segments (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_media_identities_id_session_workspace
  ON huddle_media_provider_identities (id, session_id, workspace_id);

CREATE TABLE IF NOT EXISTS huddle_intelligence_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  output_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 100,
  version INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_intelligence_jobs_type_check
    CHECK (job_type IN (
      'transcript_finalization',
      'caption_generation',
      'summary_generation',
      'decision_extraction',
      'action_item_extraction',
      'ownership_resolution',
      'timeline_generation',
      'memory_promotion',
      'meeting_digest_generation'
    )),
  CONSTRAINT huddle_intelligence_jobs_status_check
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT huddle_intelligence_jobs_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts),
  CONSTRAINT huddle_intelligence_jobs_version_check
    CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS huddle_transcript_processing_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle',
  source_provider TEXT NOT NULL DEFAULT 'unknown',
  partial_segment_count INTEGER NOT NULL DEFAULT 0,
  final_segment_count INTEGER NOT NULL DEFAULT 0,
  retracted_segment_count INTEGER NOT NULL DEFAULT 0,
  revision_count INTEGER NOT NULL DEFAULT 0,
  last_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  last_partial_at TIMESTAMPTZ,
  last_final_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  processing_version INTEGER NOT NULL DEFAULT 1,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_transcript_processing_status_check
    CHECK (status IN ('idle', 'ingesting', 'partial', 'finalizing', 'finalized', 'retracted', 'failed')),
  CONSTRAINT huddle_transcript_processing_counts_check
    CHECK (
      partial_segment_count >= 0
      AND final_segment_count >= 0
      AND retracted_segment_count >= 0
      AND revision_count >= 0
      AND processing_version >= 1
    )
);

CREATE TABLE IF NOT EXISTS huddle_speaker_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  participant_device_id UUID REFERENCES huddle_participant_devices(id) ON DELETE SET NULL,
  provider_identity_id UUID REFERENCES huddle_media_provider_identities(id) ON DELETE SET NULL,
  speaker_kind TEXT NOT NULL DEFAULT 'unknown',
  speaker_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  speaker_guest_id UUID REFERENCES huddle_guests(id) ON DELETE SET NULL,
  speaker_label TEXT,
  confidence NUMERIC(5,4),
  attribution_source TEXT NOT NULL DEFAULT 'unknown',
  provider_name TEXT,
  provider_speaker_id TEXT,
  correction_of_id UUID REFERENCES huddle_speaker_attributions(id) ON DELETE SET NULL,
  corrected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  corrected_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_speaker_attributions_kind_check
    CHECK (speaker_kind IN ('participant', 'workspace_user', 'guest', 'device', 'provider_identity', 'ai_agent', 'system', 'unknown')),
  CONSTRAINT huddle_speaker_attributions_source_check
    CHECK (attribution_source IN ('provider', 'diarization', 'manual', 'correction', 'system', 'unknown')),
  CONSTRAINT huddle_speaker_attributions_status_check
    CHECK (status IN ('active', 'corrected', 'rejected')),
  CONSTRAINT huddle_speaker_attributions_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT huddle_speaker_attributions_identity_check
    CHECK (speaker_user_id IS NULL OR speaker_guest_id IS NULL)
);

CREATE TABLE IF NOT EXISTS huddle_caption_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  speaker_attribution_id UUID REFERENCES huddle_speaker_attributions(id) ON DELETE SET NULL,
  caption_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'partial',
  source_provider TEXT NOT NULL DEFAULT 'unknown',
  sequence_number BIGINT,
  language TEXT,
  confidence NUMERIC(5,4),
  replayable BOOLEAN NOT NULL DEFAULT TRUE,
  event_version INTEGER NOT NULL DEFAULT 1,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_caption_events_status_check
    CHECK (status IN ('partial', 'final', 'retracted')),
  CONSTRAINT huddle_caption_events_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT huddle_caption_events_version_check
    CHECK (event_version >= 1)
);

CREATE TABLE IF NOT EXISTS huddle_timeline_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  event_id UUID REFERENCES huddle_session_events(id) ON DELETE SET NULL,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL,
  title TEXT,
  description TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  range_start_at TIMESTAMPTZ,
  range_end_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  confidence NUMERIC(5,4),
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_timeline_entries_type_check
    CHECK (entry_type IN ('transcript', 'decision', 'action_item', 'join', 'leave', 'milestone', 'screen_share', 'recording', 'artifact', 'system')),
  CONSTRAINT huddle_timeline_entries_range_check
    CHECK (range_end_at IS NULL OR range_start_at IS NULL OR range_end_at >= range_start_at),
  CONSTRAINT huddle_timeline_entries_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE IF NOT EXISTS huddle_ownership_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  suggested_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  suggested_owner_participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  resolved_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  confidence NUMERIC(5,4),
  approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'suggested',
  resolution_note TEXT,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_ownership_resolutions_status_check
    CHECK (status IN ('suggested', 'pending_approval', 'approved', 'reassigned', 'rejected', 'cancelled')),
  CONSTRAINT huddle_ownership_resolutions_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE IF NOT EXISTS huddle_memory_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  source_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  title TEXT,
  candidate_text TEXT NOT NULL,
  memory_visibility TEXT NOT NULL DEFAULT 'workspace',
  status TEXT NOT NULL DEFAULT 'candidate',
  confidence NUMERIC(5,4),
  approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  promoted_memory_id UUID REFERENCES workspace_memory_entries(id) ON DELETE SET NULL,
  promoted_at TIMESTAMPTZ,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_memory_candidates_status_check
    CHECK (status IN ('candidate', 'pending_approval', 'approved', 'rejected', 'promoted', 'cancelled')),
  CONSTRAINT huddle_memory_candidates_visibility_check
    CHECK (memory_visibility IN ('workspace', 'private')),
  CONSTRAINT huddle_memory_candidates_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE IF NOT EXISTS huddle_meeting_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  digest_type TEXT NOT NULL DEFAULT 'post_meeting',
  status TEXT NOT NULL DEFAULT 'draft',
  summary_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  decisions_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  actions_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  timeline_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  digest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by_job_id UUID REFERENCES huddle_intelligence_jobs(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_meeting_digests_type_check
    CHECK (digest_type IN ('live', 'post_meeting', 'what_did_i_miss', 'executive')),
  CONSTRAINT huddle_meeting_digests_status_check
    CHECK (status IN ('draft', 'pending', 'ready', 'failed', 'superseded'))
);

CREATE TABLE IF NOT EXISTS huddle_intelligence_consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  consent_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_requested',
  scope TEXT NOT NULL DEFAULT 'session',
  policy_version INTEGER NOT NULL DEFAULT 1,
  effective_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_intelligence_consent_type_check
    CHECK (consent_type IN ('transcription', 'captions', 'recording', 'ai_processing', 'memory_promotion')),
  CONSTRAINT huddle_intelligence_consent_status_check
    CHECK (status IN ('not_requested', 'requested', 'granted', 'denied', 'revoked')),
  CONSTRAINT huddle_intelligence_consent_scope_check
    CHECK (scope IN ('workspace', 'session', 'participant'))
);

CREATE TABLE IF NOT EXISTS huddle_intelligence_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  artifact_type TEXT,
  policy_name TEXT NOT NULL,
  retention_days INTEGER,
  retention_action TEXT NOT NULL DEFAULT 'retain',
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_intelligence_retention_days_check
    CHECK (retention_days IS NULL OR retention_days >= 0),
  CONSTRAINT huddle_intelligence_retention_action_check
    CHECK (retention_action IN ('retain', 'archive', 'delete', 'anonymize')),
  CONSTRAINT huddle_intelligence_retention_status_check
    CHECK (status IN ('active', 'disabled', 'superseded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcript_processing_state_session
  ON huddle_transcript_processing_state (workspace_id, session_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_intelligence_jobs_idempotency
  ON huddle_intelligence_jobs (workspace_id, session_id, job_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_jobs_queue
  ON huddle_intelligence_jobs (status, scheduled_at, priority, created_at)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_jobs_session
  ON huddle_intelligence_jobs (workspace_id, session_id, job_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_speaker_attributions_segment
  ON huddle_speaker_attributions (workspace_id, session_id, transcript_segment_id, status)
  WHERE transcript_segment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_caption_events_replay
  ON huddle_caption_events (workspace_id, session_id, emitted_at, sequence_number)
  WHERE replayable = TRUE;

CREATE INDEX IF NOT EXISTS idx_huddle_timeline_entries_session
  ON huddle_timeline_entries (workspace_id, session_id, occurred_at, sort_order);

CREATE INDEX IF NOT EXISTS idx_huddle_ownership_resolutions_status
  ON huddle_ownership_resolutions (workspace_id, session_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_memory_candidates_status
  ON huddle_memory_candidates (workspace_id, session_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_meeting_digests_session
  ON huddle_meeting_digests (workspace_id, session_id, digest_type, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_consent_session
  ON huddle_intelligence_consent_records (workspace_id, session_id, consent_type, status)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_retention_scope
  ON huddle_intelligence_retention_policies (workspace_id, session_id, artifact_type, status);

CREATE OR REPLACE FUNCTION touch_huddle_intelligence_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'huddle_intelligence_jobs',
    'huddle_transcript_processing_state',
    'huddle_speaker_attributions',
    'huddle_timeline_entries',
    'huddle_ownership_resolutions',
    'huddle_memory_candidates',
    'huddle_meeting_digests',
    'huddle_intelligence_consent_records',
    'huddle_intelligence_retention_policies'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_touch_updated_at', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_huddle_intelligence_updated_at()',
      table_name || '_touch_updated_at',
      table_name
    );
  END LOOP;
END $$;
