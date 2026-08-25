-- Fix: DELETE /superadmin/workspaces/:workspaceId/users/:userId returns 500
-- because several users(id) foreign keys have no ON DELETE action (defaults to
-- NO ACTION / RESTRICT), so removing a user who has e.g. a chat channel
-- membership or an attendance summary row throws a foreign key violation.
--
-- Every other users(id) reference in this schema already follows one of two
-- conventions: CASCADE for ownership/membership rows that must not be
-- orphaned, or SET NULL for attribution ("created_by"/"owner_id"/etc.)
-- columns on content that should survive the user being removed. These
-- constraints were the only ones missing an ON DELETE action; this migration
-- brings them in line with the rest of the schema instead of introducing a
-- new pattern. Tables are guarded with IF EXISTS since not every optional
-- feature table (e.g. okr_key_results) is present in every environment.

-- -- CASCADE: membership/ownership rows tied 1:1 or many:1 to the user -----
ALTER TABLE IF EXISTS public.attendance_daily_summary DROP CONSTRAINT IF EXISTS attendance_daily_summary_user_id_fkey;
ALTER TABLE IF EXISTS public.attendance_daily_summary ADD CONSTRAINT attendance_daily_summary_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.chat_channel_members DROP CONSTRAINT IF EXISTS chat_channel_members_user_id_fkey;
ALTER TABLE IF EXISTS public.chat_channel_members ADD CONSTRAINT chat_channel_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.dummy_notifications DROP CONSTRAINT IF EXISTS dummy_notifications_user_id_fkey;
ALTER TABLE IF EXISTS public.dummy_notifications ADD CONSTRAINT dummy_notifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.gdpr_erasure_requests DROP CONSTRAINT IF EXISTS gdpr_erasure_requests_user_id_fkey;
ALTER TABLE IF EXISTS public.gdpr_erasure_requests ADD CONSTRAINT gdpr_erasure_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.system_users DROP CONSTRAINT IF EXISTS system_users_user_id_fkey;
ALTER TABLE IF EXISTS public.system_users ADD CONSTRAINT system_users_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE IF EXISTS public.wfh_requests DROP CONSTRAINT IF EXISTS wfh_requests_user_id_fkey;
ALTER TABLE IF EXISTS public.wfh_requests ADD CONSTRAINT wfh_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- -- SET NULL: attribution columns on content that should survive ---------
ALTER TABLE IF EXISTS public.chat_channels DROP CONSTRAINT IF EXISTS chat_channels_created_by_fkey;
ALTER TABLE IF EXISTS public.chat_channels ADD CONSTRAINT chat_channels_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_user_id_fkey;
ALTER TABLE IF EXISTS public.chat_messages ADD CONSTRAINT chat_messages_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_reviewed_by_fkey;
ALTER TABLE IF EXISTS public.leave_requests ADD CONSTRAINT leave_requests_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.okr_key_results DROP CONSTRAINT IF EXISTS okr_key_results_owner_id_fkey;
ALTER TABLE IF EXISTS public.okr_key_results ADD CONSTRAINT okr_key_results_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.okr_objectives DROP CONSTRAINT IF EXISTS okr_objectives_owner_id_fkey;
ALTER TABLE IF EXISTS public.okr_objectives ADD CONSTRAINT okr_objectives_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.task_status_columns DROP CONSTRAINT IF EXISTS task_status_columns_created_by_fkey;
ALTER TABLE IF EXISTS public.task_status_columns ADD CONSTRAINT task_status_columns_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.wfh_requests DROP CONSTRAINT IF EXISTS wfh_requests_approved_by_fkey;
ALTER TABLE IF EXISTS public.wfh_requests ADD CONSTRAINT wfh_requests_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.wiki_page_versions DROP CONSTRAINT IF EXISTS wiki_page_versions_edited_by_fkey;
ALTER TABLE IF EXISTS public.wiki_page_versions ADD CONSTRAINT wiki_page_versions_edited_by_fkey
  FOREIGN KEY (edited_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_created_by_fkey;
ALTER TABLE IF EXISTS public.wiki_pages ADD CONSTRAINT wiki_pages_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_updated_by_fkey;
ALTER TABLE IF EXISTS public.wiki_pages ADD CONSTRAINT wiki_pages_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.wiki_spaces DROP CONSTRAINT IF EXISTS wiki_spaces_created_by_fkey;
ALTER TABLE IF EXISTS public.wiki_spaces ADD CONSTRAINT wiki_spaces_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
