-- Closes the two remaining latent delete traps found by auditing every
-- foreign key, CHECK and validation trigger reachable from a delete.
-- Neither is reachable today (the tables are empty in production), but both
-- would break a delete the moment they hold a row.
--
-- 1. huddle_guests -> huddle_session_participants.guest_id and
--    huddle_media_provider_identities.guest_id are ON DELETE SET NULL, while
--    the identity CHECKs on those same tables require guest_id to stay NOT
--    NULL whenever the row's kind is 'guest'. That is the identical shape
--    already fixed for user_id in 20260825c, and the fix is the same one this
--    subsystem already uses elsewhere: huddle_recovery_fences and
--    huddle_restore_attempts (20260604_huddle_restoration_readiness.sql)
--    CASCADE on both user_id and guest_id. Deleting a guest removes their
--    membership rows rather than leaving rows no CHECK will accept; the
--    session, its transcript and its artifacts are untouched.
--
-- 2. attendance_daily_summary, offices and wfh_requests reference
--    workspaces(id) with no ON DELETE action, so they would block workspace
--    deletion outright. Every other workspace-scoped table in this schema
--    uses ON DELETE CASCADE -- these three are simply out of step.

ALTER TABLE IF EXISTS public.huddle_session_participants
  DROP CONSTRAINT IF EXISTS huddle_session_participants_guest_id_fkey;
ALTER TABLE IF EXISTS public.huddle_session_participants
  ADD CONSTRAINT huddle_session_participants_guest_id_fkey
  FOREIGN KEY (guest_id) REFERENCES public.huddle_guests(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.huddle_media_provider_identities
  DROP CONSTRAINT IF EXISTS huddle_media_provider_identities_guest_id_fkey;
ALTER TABLE IF EXISTS public.huddle_media_provider_identities
  ADD CONSTRAINT huddle_media_provider_identities_guest_id_fkey
  FOREIGN KEY (guest_id) REFERENCES public.huddle_guests(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.attendance_daily_summary
  DROP CONSTRAINT IF EXISTS attendance_daily_summary_workspace_id_fkey;
ALTER TABLE IF EXISTS public.attendance_daily_summary
  ADD CONSTRAINT attendance_daily_summary_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.offices
  DROP CONSTRAINT IF EXISTS offices_workspace_id_fkey;
ALTER TABLE IF EXISTS public.offices
  ADD CONSTRAINT offices_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.wfh_requests
  DROP CONSTRAINT IF EXISTS wfh_requests_workspace_id_fkey;
ALTER TABLE IF EXISTS public.wfh_requests
  ADD CONSTRAINT wfh_requests_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
