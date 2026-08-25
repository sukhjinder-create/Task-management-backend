-- Second follow-up to 20260825_user_delete_fk_cleanup.sql.
--
-- huddle_session_participants.user_id and huddle_media_provider_identities.user_id
-- are declared ON DELETE SET NULL, but both tables also carry a "kind"-discriminated
-- CHECK constraint that requires user_id to stay NOT NULL whenever
-- participant_kind/identity_kind = 'workspace_user':
--   huddle_participants_identity_check, huddle_media_identities_identity_check
-- huddle_session_participants additionally has a BEFORE trigger
-- (validate_huddle_participant_ownership) enforcing the same rule, which is what
-- surfaced this as "Huddle participant user <NULL> does not belong to workspace
-- ..." instead of a plain FK error. So SET NULL can never actually succeed for a
-- workspace_user row -- it just trades one constraint violation for another.
--
-- This codebase already solved the identical problem correctly elsewhere: the
-- twin identity-discriminated tables huddle_recovery_fences and
-- huddle_restore_attempts (see 20260604_huddle_restoration_readiness.sql) use
-- ON DELETE CASCADE for their user_id column. This migration brings these two
-- tables in line with that existing convention: deleting a user removes their
-- "was in this call" / "was on this call's media session" row instead of
-- leaving it in a state neither the CHECK nor the trigger will accept. This
-- does not touch huddle_sessions, huddle_session_events, or huddle_artifacts --
-- those already validate as IS NOT NULL-guarded (skip cleanly on NULL) and stay
-- SET NULL, so call history/transcripts/summaries are unaffected.

ALTER TABLE IF EXISTS public.huddle_session_participants DROP CONSTRAINT IF EXISTS huddle_session_participants_user_id_fkey;
ALTER TABLE IF EXISTS public.huddle_session_participants ADD CONSTRAINT huddle_session_participants_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.huddle_media_provider_identities DROP CONSTRAINT IF EXISTS huddle_media_provider_identities_user_id_fkey;
ALTER TABLE IF EXISTS public.huddle_media_provider_identities ADD CONSTRAINT huddle_media_provider_identities_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
