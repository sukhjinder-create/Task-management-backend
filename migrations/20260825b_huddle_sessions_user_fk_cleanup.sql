-- Follow-up to 20260825_user_delete_fk_cleanup.sql.
--
-- huddle_sessions.started_by and huddle_sessions.host_user_id are NOT NULL
-- and were explicitly declared ON DELETE RESTRICT, so any user who has ever
-- started or hosted a huddle call could never be deleted. Every other actor
-- reference on this same table (ended_by, invited_by, actor_user_id,
-- created_by) already uses ON DELETE SET NULL so the session and its
-- transcripts/artifacts/participants survive the user being removed -- these
-- two columns were the only ones out of step with that pattern.
--
-- CASCADE is deliberately not used here: huddle_sessions is the parent row
-- for huddle_session_participants, huddle_participant_devices,
-- huddle_session_events, huddle_artifacts and the huddle intelligence
-- tables, all keyed off session_id with their own ON DELETE CASCADE. Cascading
-- through started_by/host_user_id would silently destroy call history,
-- transcripts and summaries for every other participant just because the
-- host account was deleted -- SET NULL preserves that shared data and matches
-- the rest of the table.

ALTER TABLE IF EXISTS public.huddle_sessions ALTER COLUMN started_by DROP NOT NULL;
ALTER TABLE IF EXISTS public.huddle_sessions ALTER COLUMN host_user_id DROP NOT NULL;

ALTER TABLE IF EXISTS public.huddle_sessions DROP CONSTRAINT IF EXISTS huddle_sessions_started_by_fkey;
ALTER TABLE IF EXISTS public.huddle_sessions ADD CONSTRAINT huddle_sessions_started_by_fkey
  FOREIGN KEY (started_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.huddle_sessions DROP CONSTRAINT IF EXISTS huddle_sessions_host_user_id_fkey;
ALTER TABLE IF EXISTS public.huddle_sessions ADD CONSTRAINT huddle_sessions_host_user_id_fkey
  FOREIGN KEY (host_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
