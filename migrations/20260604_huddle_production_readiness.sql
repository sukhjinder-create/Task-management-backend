-- Epic 3B: production-readiness hardening for legacy and session Huddles.
-- Additive and rerunnable. New writes are protected immediately; historical
-- rows that cannot be scoped safely are left for explicit reconciliation.

ALTER TABLE chat_huddles
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- Prefer the workspace already recorded by a session when exactly one exists.
WITH candidates AS (
  SELECT
    h.id AS huddle_row_id,
    MIN(s.workspace_id::TEXT)::UUID AS workspace_id
  FROM chat_huddles h
  JOIN huddle_sessions s
    ON s.legacy_huddle_id = h.huddle_id
   AND s.legacy_channel_key = h.channel_key
  WHERE h.workspace_id IS NULL
  GROUP BY h.id
  HAVING COUNT(DISTINCT s.workspace_id) = 1
)
UPDATE chat_huddles h
SET workspace_id = candidates.workspace_id
FROM candidates
WHERE h.id = candidates.huddle_row_id
  AND h.workspace_id IS NULL;

-- Scope channel Huddles only when the channel and starter identify one workspace.
WITH candidates AS (
  SELECT
    h.id AS huddle_row_id,
    MIN(c.workspace_id::TEXT)::UUID AS workspace_id
  FROM chat_huddles h
  JOIN chat_channels c
    ON c.key = h.channel_key
   AND c.workspace_id IS NOT NULL
  JOIN workspace_users wu
    ON wu.workspace_id = c.workspace_id
   AND wu.user_id = h.started_by
   AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
  WHERE h.workspace_id IS NULL
    AND h.channel_key NOT LIKE 'dm:%'
    AND h.channel_key NOT LIKE 'thread:%'
  GROUP BY h.id
  HAVING COUNT(DISTINCT c.workspace_id) = 1
)
UPDATE chat_huddles h
SET workspace_id = candidates.workspace_id
FROM candidates
WHERE h.id = candidates.huddle_row_id
  AND h.workspace_id IS NULL;

-- Thread message IDs are globally unique and carry their workspace directly.
WITH candidates AS (
  SELECT
    h.id AS huddle_row_id,
    MIN(m.workspace_id::TEXT)::UUID AS workspace_id
  FROM chat_huddles h
  JOIN chat_messages m
    ON m.id = CASE
      WHEN h.channel_key ~* '^thread:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN split_part(h.channel_key, ':', 2)::UUID
      ELSE NULL
    END
  JOIN workspace_users wu
    ON wu.workspace_id = m.workspace_id
   AND wu.user_id = h.started_by
   AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
  WHERE h.workspace_id IS NULL
    AND h.channel_key ~* '^thread:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  GROUP BY h.id
  HAVING COUNT(DISTINCT m.workspace_id) = 1
)
UPDATE chat_huddles h
SET workspace_id = candidates.workspace_id
FROM candidates
WHERE h.id = candidates.huddle_row_id
  AND h.workspace_id IS NULL;

-- DM Huddles are scoped only when both participants and the starter share one
-- active workspace membership.
WITH candidates AS (
  SELECT
    h.id AS huddle_row_id,
    MIN(a.workspace_id::TEXT)::UUID AS workspace_id
  FROM chat_huddles h
  JOIN workspace_users a
    ON a.user_id = CASE
      WHEN h.channel_key ~* '^dm:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN split_part(h.channel_key, ':', 2)::UUID
      ELSE NULL
    END
   AND (a.billing_status IS NULL OR a.billing_status != 'pending')
  JOIN workspace_users b
    ON b.workspace_id = a.workspace_id
   AND b.user_id = CASE
     WHEN h.channel_key ~* '^dm:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     THEN split_part(h.channel_key, ':', 3)::UUID
     ELSE NULL
   END
   AND (b.billing_status IS NULL OR b.billing_status != 'pending')
  JOIN workspace_users starter
    ON starter.workspace_id = a.workspace_id
   AND starter.user_id = h.started_by
   AND (starter.billing_status IS NULL OR starter.billing_status != 'pending')
  WHERE h.workspace_id IS NULL
    AND h.channel_key ~* '^dm:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  GROUP BY h.id
  HAVING COUNT(DISTINCT a.workspace_id) = 1
)
UPDATE chat_huddles h
SET workspace_id = candidates.workspace_id
FROM candidates
WHERE h.id = candidates.huddle_row_id
  AND h.workspace_id IS NULL;

-- A starter with one active workspace is an unambiguous final fallback.
WITH candidates AS (
  SELECT
    h.id AS huddle_row_id,
    MIN(wu.workspace_id::TEXT)::UUID AS workspace_id
  FROM chat_huddles h
  JOIN workspace_users wu
    ON wu.user_id = h.started_by
   AND (wu.billing_status IS NULL OR wu.billing_status != 'pending')
  WHERE h.workspace_id IS NULL
  GROUP BY h.id
  HAVING COUNT(DISTINCT wu.workspace_id) = 1
)
UPDATE chat_huddles h
SET workspace_id = candidates.workspace_id
FROM candidates
WHERE h.id = candidates.huddle_row_id
  AND h.workspace_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_huddles_workspace_id_fkey'
  ) THEN
    ALTER TABLE chat_huddles
      ADD CONSTRAINT chat_huddles_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_huddles_active_workspace_check'
  ) THEN
    ALTER TABLE chat_huddles
      ADD CONSTRAINT chat_huddles_active_workspace_check
      CHECK (ended_at IS NOT NULL OR workspace_id IS NOT NULL)
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chat_huddles_workspace_channel_active
  ON chat_huddles (workspace_id, channel_key, started_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_huddles_workspace_huddle
  ON chat_huddles (workspace_id, huddle_id);

-- Composite uniqueness supports workspace-consistent foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_channels_id_workspace
  ON chat_channels (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_messages_id_workspace
  ON chat_messages (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_sessions_id_workspace
  ON huddle_sessions (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_guests_id_workspace
  ON huddle_guests (id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_participants_id_session_workspace
  ON huddle_session_participants (id, session_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_huddle_events_id_session_workspace
  ON huddle_session_events (id, session_id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_sessions_channel_workspace_fk'
  ) THEN
    ALTER TABLE huddle_sessions
      ADD CONSTRAINT huddle_sessions_channel_workspace_fk
      FOREIGN KEY (channel_id, workspace_id)
      REFERENCES chat_channels(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_sessions_thread_workspace_fk'
  ) THEN
    ALTER TABLE huddle_sessions
      ADD CONSTRAINT huddle_sessions_thread_workspace_fk
      FOREIGN KEY (thread_message_id, workspace_id)
      REFERENCES chat_messages(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_participants_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_session_participants
      ADD CONSTRAINT huddle_participants_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_participants_guest_workspace_fk'
  ) THEN
    ALTER TABLE huddle_session_participants
      ADD CONSTRAINT huddle_participants_guest_workspace_fk
      FOREIGN KEY (guest_id, workspace_id)
      REFERENCES huddle_guests(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_devices_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_participant_devices
      ADD CONSTRAINT huddle_devices_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_devices_participant_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_participant_devices
      ADD CONSTRAINT huddle_devices_participant_session_workspace_fk
      FOREIGN KEY (participant_id, session_id, workspace_id)
      REFERENCES huddle_session_participants(id, session_id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_devices_guest_workspace_fk'
  ) THEN
    ALTER TABLE huddle_participant_devices
      ADD CONSTRAINT huddle_devices_guest_workspace_fk
      FOREIGN KEY (guest_id, workspace_id)
      REFERENCES huddle_guests(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_events_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_session_events
      ADD CONSTRAINT huddle_events_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_events_actor_guest_workspace_fk'
  ) THEN
    ALTER TABLE huddle_session_events
      ADD CONSTRAINT huddle_events_actor_guest_workspace_fk
      FOREIGN KEY (actor_guest_id, workspace_id)
      REFERENCES huddle_guests(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_events_actor_identity_check'
  ) THEN
    ALTER TABLE huddle_session_events
      ADD CONSTRAINT huddle_events_actor_identity_check
      CHECK (actor_user_id IS NULL OR actor_guest_id IS NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifacts_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifacts
      ADD CONSTRAINT huddle_artifacts_session_workspace_fk
      FOREIGN KEY (session_id, workspace_id)
      REFERENCES huddle_sessions(id, workspace_id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'huddle_artifacts_source_event_session_workspace_fk'
  ) THEN
    ALTER TABLE huddle_artifacts
      ADD CONSTRAINT huddle_artifacts_source_event_session_workspace_fk
      FOREIGN KEY (source_event_id, session_id, workspace_id)
      REFERENCES huddle_session_events(id, session_id, workspace_id)
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_participant_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.participant_kind = 'workspace_user'
     AND NOT EXISTS (
       SELECT 1
       FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.user_id
     ) THEN
    RAISE EXCEPTION 'Huddle participant user % does not belong to workspace %',
      NEW.user_id,
      NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.participant_kind = 'guest'
     AND NOT EXISTS (
       SELECT 1
       FROM huddle_guests g
       WHERE g.id = NEW.guest_id
         AND g.workspace_id = NEW.workspace_id
     ) THEN
    RAISE EXCEPTION 'Huddle participant guest % does not belong to workspace %',
      NEW.guest_id,
      NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_device_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM huddle_session_participants p
    WHERE p.id = NEW.participant_id
      AND p.session_id = NEW.session_id
      AND p.workspace_id = NEW.workspace_id
      AND p.user_id IS NOT DISTINCT FROM NEW.user_id
      AND p.guest_id IS NOT DISTINCT FROM NEW.guest_id
  ) THEN
    RAISE EXCEPTION 'Huddle device participant ownership mismatch'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_event_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.actor_user_id
     ) THEN
    RAISE EXCEPTION 'Huddle event actor % does not belong to workspace %',
      NEW.actor_user_id,
      NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_huddle_artifact_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM workspace_users wu
       WHERE wu.workspace_id = NEW.workspace_id
         AND wu.user_id = NEW.created_by
     ) THEN
    RAISE EXCEPTION 'Huddle artifact creator % does not belong to workspace %',
      NEW.created_by,
      NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS huddle_participants_validate_ownership
  ON huddle_session_participants;
CREATE TRIGGER huddle_participants_validate_ownership
  BEFORE INSERT OR UPDATE OF session_id, workspace_id, participant_kind, user_id, guest_id
  ON huddle_session_participants
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_participant_ownership();

DROP TRIGGER IF EXISTS huddle_devices_validate_ownership
  ON huddle_participant_devices;
CREATE TRIGGER huddle_devices_validate_ownership
  BEFORE INSERT OR UPDATE OF session_id, participant_id, workspace_id, user_id, guest_id
  ON huddle_participant_devices
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_device_ownership();

DROP TRIGGER IF EXISTS huddle_events_validate_ownership
  ON huddle_session_events;
CREATE TRIGGER huddle_events_validate_ownership
  BEFORE INSERT OR UPDATE OF session_id, workspace_id, actor_user_id, actor_guest_id
  ON huddle_session_events
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_event_ownership();

DROP TRIGGER IF EXISTS huddle_artifacts_validate_ownership
  ON huddle_artifacts;
CREATE TRIGGER huddle_artifacts_validate_ownership
  BEFORE INSERT OR UPDATE OF session_id, workspace_id, created_by, source_event_id
  ON huddle_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION validate_huddle_artifact_ownership();

-- Validate clean constraints, but do not abort deployment because of historical
-- rows. Any constraint left unvalidated still protects all new writes.
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT *
    FROM (
      VALUES
        ('chat_huddles', 'chat_huddles_workspace_id_fkey'),
        ('chat_huddles', 'chat_huddles_active_workspace_check'),
        ('huddle_sessions', 'huddle_sessions_channel_workspace_fk'),
        ('huddle_sessions', 'huddle_sessions_thread_workspace_fk'),
        ('huddle_session_participants', 'huddle_participants_session_workspace_fk'),
        ('huddle_session_participants', 'huddle_participants_guest_workspace_fk'),
        ('huddle_participant_devices', 'huddle_devices_session_workspace_fk'),
        ('huddle_participant_devices', 'huddle_devices_participant_session_workspace_fk'),
        ('huddle_participant_devices', 'huddle_devices_guest_workspace_fk'),
        ('huddle_session_events', 'huddle_events_session_workspace_fk'),
        ('huddle_session_events', 'huddle_events_actor_guest_workspace_fk'),
        ('huddle_session_events', 'huddle_events_actor_identity_check'),
        ('huddle_artifacts', 'huddle_artifacts_session_workspace_fk'),
        ('huddle_artifacts', 'huddle_artifacts_source_event_session_workspace_fk')
    ) AS constraints_to_validate(table_name, constraint_name)
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        item.table_name,
        item.constraint_name
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Huddle constraint % on % remains NOT VALID: %',
        item.constraint_name,
        item.table_name,
        SQLERRM;
    END;
  END LOOP;
END $$;

DO $$
DECLARE
  remaining_active_unscoped INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER
  INTO remaining_active_unscoped
  FROM chat_huddles
  WHERE ended_at IS NULL
    AND workspace_id IS NULL;

  IF remaining_active_unscoped > 0 THEN
    RAISE WARNING '% active legacy Huddle rows could not be scoped safely and require manual reconciliation',
      remaining_active_unscoped;
  END IF;
END $$;
