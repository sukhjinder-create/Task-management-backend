-- Rollback for Epic 5C Foundation media-session persistence.
-- Idempotent and safe to run repeatedly.
--
-- This removes only the additive LiveKit-readiness media-session artifacts from
-- 20260605_huddle_media_sessions.sql. Existing Huddle lifecycle/session tables
-- remain intact.

BEGIN;

DROP TRIGGER IF EXISTS huddle_media_identities_validate_ownership
  ON huddle_media_provider_identities;

DROP FUNCTION IF EXISTS validate_huddle_media_identity_ownership();

DROP TABLE IF EXISTS huddle_media_provider_identities;

DROP TABLE IF EXISTS huddle_media_sessions;

DROP INDEX IF EXISTS uniq_huddle_devices_id_session_workspace;

COMMIT;
