-- Third follow-up to 20260825_user_delete_fk_cleanup.sql.
--
-- huddle_participant_devices.user_id is a *second*, independent ON DELETE SET
-- NULL path to users(id) -- separate from huddle_session_participants.user_id,
-- which 20260825c switched to CASCADE. When a user is deleted, Postgres
-- processes both FK actions for the same statement without a guaranteed
-- order: the direct SET NULL on huddle_participant_devices.user_id can fire
-- before the CASCADE-delete of its parent huddle_session_participants row
-- removes the device row entirely. At that moment the BEFORE UPDATE trigger
-- validate_huddle_device_ownership() finds the device's (now NULL) user_id no
-- longer matches its still-present parent participant's user_id and raises
-- "Huddle device participant ownership mismatch".
--
-- Switching this FK to CASCADE too removes the race outright: whichever path
-- runs first, the device row simply ends up deleted rather than transiently
-- nulled out of step with its parent, so the ownership trigger never sees an
-- inconsistent row. This only affects "which devices were in this call" rows
-- for the deleted user -- huddle_sessions, transcripts, and artifacts are
-- untouched.

ALTER TABLE IF EXISTS public.huddle_participant_devices DROP CONSTRAINT IF EXISTS huddle_participant_devices_user_id_fkey;
ALTER TABLE IF EXISTS public.huddle_participant_devices ADD CONSTRAINT huddle_participant_devices_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
