-- Meeting Intelligence V2: language normalization, topic segmentation, and a
-- dedicated risk/blocker extraction stage. Purely additive — no existing
-- column, table, or row is altered or dropped. Safe to run multiple times.

-- Language normalization: the canonical transcript_text stays exactly as
-- captured (untranslated) per the existing canonicalTranscriptTranslated
-- contract. normalized_text/detected_language are a parallel, optional
-- English-normalized view used by topic segmentation and the executive
-- summary stage so they work from consistent English input regardless of
-- what language a segment was actually spoken in.
ALTER TABLE huddle_transcript_segments
  ADD COLUMN IF NOT EXISTS normalized_text TEXT,
  ADD COLUMN IF NOT EXISTS detected_language TEXT,
  ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS huddle_topic_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  start_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  end_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  evidence_segment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC,
  generation_job_id UUID REFERENCES huddle_intelligence_jobs(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_topic_segments_sequence_check CHECK (sequence_number >= 0),
  CONSTRAINT huddle_topic_segments_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS idx_huddle_topic_segments_session
  ON huddle_topic_segments (workspace_id, session_id, sequence_number);

CREATE TABLE IF NOT EXISTS huddle_risk_blocker_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  topic_segment_id UUID REFERENCES huddle_topic_segments(id) ON DELETE SET NULL,
  item_type TEXT NOT NULL,
  text TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  owner_participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE SET NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  evidence_segment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC,
  generation_job_id UUID REFERENCES huddle_intelligence_jobs(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_risk_blocker_items_type_check
    CHECK (item_type IN ('risk', 'blocker')),
  CONSTRAINT huddle_risk_blocker_items_severity_check
    CHECK (severity IN ('low', 'medium', 'high')),
  CONSTRAINT huddle_risk_blocker_items_status_check
    CHECK (status IN ('open', 'mitigated', 'resolved')),
  CONSTRAINT huddle_risk_blocker_items_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS idx_huddle_risk_blocker_items_session
  ON huddle_risk_blocker_items (workspace_id, session_id, item_type, status);

ALTER TABLE huddle_intelligence_jobs
  DROP CONSTRAINT IF EXISTS huddle_intelligence_jobs_type_check;

ALTER TABLE huddle_intelligence_jobs
  ADD CONSTRAINT huddle_intelligence_jobs_type_check
  CHECK (job_type IN (
    'transcript_finalization',
    'caption_generation',
    'summary_generation',
    'decision_extraction',
    'action_item_extraction',
    'ownership_resolution',
    'timeline_generation',
    'memory_promotion',
    'meeting_digest_generation',
    'language_normalization',
    'topic_segmentation',
    'risk_blocker_extraction'
  ));
