-- Phase 1 Huddle Intelligence foundation: artifact domain architecture.
-- Additive and idempotent. No AI generation, captions, or memory promotion.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_id_workspace
  ON huddle_sessions (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_artifacts_id_session_workspace
  ON huddle_artifacts (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_events_id_session_workspace
  ON huddle_session_events (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_transcript_segments_id_session_workspace
  ON huddle_transcript_segments (id, session_id, workspace_id);

ALTER TABLE huddle_artifacts
  ADD COLUMN IF NOT EXISTS current_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_note TEXT,
  ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE huddle_artifacts
  DROP CONSTRAINT IF EXISTS huddle_artifacts_type_check;
ALTER TABLE huddle_artifacts
  ADD CONSTRAINT huddle_artifacts_type_check
  CHECK (artifact_type IN (
    'recording',
    'transcript',
    'summary',
    'decision',
    'action_item',
    'timeline',
    'memory',
    'ai_memory',
    'task_link',
    'chat_follow_up',
    'quality_report',
    'compliance_export'
  ));

ALTER TABLE huddle_artifacts
  DROP CONSTRAINT IF EXISTS huddle_artifacts_status_check;
ALTER TABLE huddle_artifacts
  ADD CONSTRAINT huddle_artifacts_status_check
  CHECK (status IN (
    'draft',
    'pending',
    'processing',
    'ready',
    'failed',
    'archived',
    'superseded',
    'deleted'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifacts_approval_status_check'
  ) THEN
    ALTER TABLE huddle_artifacts
      ADD CONSTRAINT huddle_artifacts_approval_status_check
      CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected', 'revoked'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifacts_revision_check'
  ) THEN
    ALTER TABLE huddle_artifacts
      ADD CONSTRAINT huddle_artifacts_revision_check
      CHECK (current_revision >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS huddle_artifact_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES huddle_artifacts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  artifact_type TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_text TEXT,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_event_id UUID REFERENCES huddle_session_events(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_artifact_revisions_type_check
    CHECK (artifact_type IN ('transcript', 'summary', 'decision', 'action_item', 'timeline', 'memory', 'ai_memory', 'recording', 'task_link', 'chat_follow_up', 'quality_report', 'compliance_export')),
  CONSTRAINT huddle_artifact_revisions_status_check
    CHECK (status IN ('draft', 'pending', 'processing', 'ready', 'failed', 'archived', 'superseded', 'deleted')),
  CONSTRAINT huddle_artifact_revisions_approval_status_check
    CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected', 'revoked')),
  CONSTRAINT huddle_artifact_revisions_number_check
    CHECK (revision_number >= 1)
);

CREATE TABLE IF NOT EXISTS huddle_artifact_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES huddle_artifacts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  transcript_segment_id UUID REFERENCES huddle_transcript_segments(id) ON DELETE SET NULL,
  source_artifact_id UUID REFERENCES huddle_artifacts(id) ON DELETE SET NULL,
  source_event_id UUID REFERENCES huddle_session_events(id) ON DELETE SET NULL,
  source_ref TEXT,
  range_start_at TIMESTAMPTZ,
  range_end_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_artifact_sources_kind_check
    CHECK (source_kind IN ('transcript_segment', 'transcript_range', 'artifact', 'event', 'manual', 'provider')),
  CONSTRAINT huddle_artifact_sources_range_check
    CHECK (range_end_at IS NULL OR range_start_at IS NULL OR range_end_at >= range_start_at)
);

CREATE TABLE IF NOT EXISTS huddle_artifact_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES huddle_artifacts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  principal_kind TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES huddle_session_participants(id) ON DELETE CASCADE,
  role_name TEXT,
  permission TEXT NOT NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT huddle_artifact_permissions_principal_kind_check
    CHECK (principal_kind IN ('workspace', 'session_participants', 'user', 'participant', 'role')),
  CONSTRAINT huddle_artifact_permissions_permission_check
    CHECK (permission IN ('read', 'write', 'approve', 'admin')),
  CONSTRAINT huddle_artifact_permissions_principal_check
    CHECK (
      (principal_kind = 'workspace' AND user_id IS NULL AND participant_id IS NULL AND role_name IS NULL)
      OR (principal_kind = 'session_participants' AND user_id IS NULL AND participant_id IS NULL AND role_name IS NULL)
      OR (principal_kind = 'user' AND user_id IS NOT NULL AND participant_id IS NULL AND role_name IS NULL)
      OR (principal_kind = 'participant' AND participant_id IS NOT NULL AND user_id IS NULL AND role_name IS NULL)
      OR (principal_kind = 'role' AND role_name IS NOT NULL AND user_id IS NULL AND participant_id IS NULL)
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_revisions_artifact_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_revisions
      ADD CONSTRAINT huddle_artifact_revisions_artifact_session_workspace_fk
      FOREIGN KEY (artifact_id, session_id, workspace_id)
      REFERENCES huddle_artifacts(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_revisions_source_event_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_revisions
      ADD CONSTRAINT huddle_artifact_revisions_source_event_session_workspace_fk
      FOREIGN KEY (source_event_id, session_id, workspace_id)
      REFERENCES huddle_session_events(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_sources_artifact_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_sources
      ADD CONSTRAINT huddle_artifact_sources_artifact_session_workspace_fk
      FOREIGN KEY (artifact_id, session_id, workspace_id)
      REFERENCES huddle_artifacts(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_sources_transcript_segment_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_sources
      ADD CONSTRAINT huddle_artifact_sources_transcript_segment_session_workspace_fk
      FOREIGN KEY (transcript_segment_id, session_id, workspace_id)
      REFERENCES huddle_transcript_segments(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_sources_source_artifact_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_sources
      ADD CONSTRAINT huddle_artifact_sources_source_artifact_workspace_fk
      FOREIGN KEY (source_artifact_id, session_id, workspace_id)
      REFERENCES huddle_artifacts(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_sources_event_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_sources
      ADD CONSTRAINT huddle_artifact_sources_event_session_workspace_fk
      FOREIGN KEY (source_event_id, session_id, workspace_id)
      REFERENCES huddle_session_events(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_permissions_artifact_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_permissions
      ADD CONSTRAINT huddle_artifact_permissions_artifact_session_workspace_fk
      FOREIGN KEY (artifact_id, session_id, workspace_id)
      REFERENCES huddle_artifacts(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifact_permissions_participant_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifact_permissions
      ADD CONSTRAINT huddle_artifact_permissions_participant_session_workspace_fk
      FOREIGN KEY (participant_id, session_id, workspace_id)
      REFERENCES huddle_session_participants(id, session_id, workspace_id)
      NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_artifact_revisions_number
  ON huddle_artifact_revisions (artifact_id, revision_number);

CREATE INDEX IF NOT EXISTS idx_huddle_artifacts_session_type_status
  ON huddle_artifacts (workspace_id, session_id, artifact_type, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_artifacts_approval
  ON huddle_artifacts (workspace_id, approval_status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_artifacts_retention
  ON huddle_artifacts (workspace_id, retention_expires_at)
  WHERE retention_expires_at IS NOT NULL AND deleted_at IS NULL AND retention_hold = FALSE;

CREATE INDEX IF NOT EXISTS idx_huddle_artifact_revisions_artifact
  ON huddle_artifact_revisions (artifact_id, revision_number DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_artifact_sources_artifact
  ON huddle_artifact_sources (artifact_id, source_kind, created_at);

CREATE INDEX IF NOT EXISTS idx_huddle_artifact_sources_transcript
  ON huddle_artifact_sources (workspace_id, session_id, transcript_segment_id)
  WHERE transcript_segment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_artifact_permissions_artifact
  ON huddle_artifact_permissions (artifact_id, permission)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_huddle_artifact_permissions_user
  ON huddle_artifact_permissions (workspace_id, user_id, permission)
  WHERE user_id IS NOT NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION validate_huddle_artifact_intelligence_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.approved_by
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Huddle artifact approver does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.rejected_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.rejected_by
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Huddle artifact rejecter does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.updated_at IS NOT NULL THEN
    NEW.updated_at = now();
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_artifact_revision_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.created_by
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Huddle artifact revision creator does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_artifact_source_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.created_by
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Huddle artifact source creator does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_artifact_permission_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.user_id
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Huddle artifact permission user does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.granted_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.granted_by
         AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
     ) THEN
    RAISE EXCEPTION 'Huddle artifact permission grantor does not belong to workspace'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS huddle_artifacts_validate_intelligence_ownership
  ON huddle_artifacts;
CREATE TRIGGER huddle_artifacts_validate_intelligence_ownership
  BEFORE UPDATE OF approval_status, approved_by, rejected_by, current_revision, retention_expires_at, retention_hold, provenance_json
  ON huddle_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_artifact_intelligence_ownership();

DROP TRIGGER IF EXISTS huddle_artifact_revisions_validate_ownership
  ON huddle_artifact_revisions;
CREATE TRIGGER huddle_artifact_revisions_validate_ownership
  BEFORE INSERT OR UPDATE OF artifact_id, session_id, workspace_id, created_by, source_event_id
  ON huddle_artifact_revisions
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_artifact_revision_ownership();

DROP TRIGGER IF EXISTS huddle_artifact_sources_validate_ownership
  ON huddle_artifact_sources;
CREATE TRIGGER huddle_artifact_sources_validate_ownership
  BEFORE INSERT OR UPDATE OF artifact_id, session_id, workspace_id, transcript_segment_id, source_artifact_id, source_event_id, created_by
  ON huddle_artifact_sources
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_artifact_source_ownership();

DROP TRIGGER IF EXISTS huddle_artifact_permissions_validate_ownership
  ON huddle_artifact_permissions;
CREATE TRIGGER huddle_artifact_permissions_validate_ownership
  BEFORE INSERT OR UPDATE OF artifact_id, session_id, workspace_id, principal_kind, user_id, participant_id, granted_by
  ON huddle_artifact_permissions
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_artifact_permission_ownership();

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT *
    FROM (
      VALUES
        ('huddle_artifact_revisions', 'huddle_artifact_revisions_artifact_session_workspace_fk'),
        ('huddle_artifact_revisions', 'huddle_artifact_revisions_source_event_session_workspace_fk'),
        ('huddle_artifact_sources', 'huddle_artifact_sources_artifact_session_workspace_fk'),
        ('huddle_artifact_sources', 'huddle_artifact_sources_transcript_segment_session_workspace_fk'),
        ('huddle_artifact_sources', 'huddle_artifact_sources_source_artifact_workspace_fk'),
        ('huddle_artifact_sources', 'huddle_artifact_sources_event_session_workspace_fk'),
        ('huddle_artifact_permissions', 'huddle_artifact_permissions_artifact_session_workspace_fk'),
        ('huddle_artifact_permissions', 'huddle_artifact_permissions_participant_session_workspace_fk')
    ) AS constraints_to_validate(table_name, constraint_name)
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        item.table_name,
        item.constraint_name
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Huddle artifact constraint % on % remains NOT VALID: %',
        item.constraint_name,
        item.table_name,
        SQLERRM;
    END;
  END LOOP;
END $$;
