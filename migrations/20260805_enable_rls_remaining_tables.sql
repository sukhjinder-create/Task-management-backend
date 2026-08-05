-- Enable Row Level Security on every remaining public table.
--
-- 20260430_enable_rls_all_tables.sql enabled RLS across the database, and the
-- product has treated "every table has RLS" as true ever since. It has not been
-- true since the day after: that migration listed tables by name, so every table
-- created afterwards silently arrived unprotected. This restores the invariant
-- for the 85 tables that had drifted out of it.
--
-- The exposure was not limited to platform metadata. Meeting content
-- (huddle_transcript_segments, huddle_sessions, huddle_caption_events), billing
-- (billing_plan_prices, trial_signup_checkout_sessions) and the per-entity
-- intelligence tables were all reachable by any caller holding an anon or
-- authenticated Supabase key, because RLS is what makes PostgREST refuse them.
--
-- WHY THIS CANNOT BREAK THE BACKEND: the API never uses a Supabase client. It
-- connects over DATABASE_URL as the table owner, and an owner bypasses RLS
-- unless FORCE ROW LEVEL SECURITY is set -- which is deliberately NOT set here.
-- Verified before writing this: the backend has no Supabase createClient() at
-- all (the only one is Redis), and the frontend contains no Supabase reference,
-- so every read and write already goes through the API.
--
-- No policies are created, matching 20260430: with RLS on and no policy, direct
-- anon/authenticated access is denied outright, which is the intent. Adding a
-- policy later is additive and safe.
--
-- Idempotent: enabling RLS on a table that already has it is a no-op, so
-- re-running this is harmless.

ALTER TABLE public.ai_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_request_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_runtime_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_workspace_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plan_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plan_provider_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_integration_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_calibration_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_learning_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_learning_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_org_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_reasoning_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ei_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enterprise_intelligence_cutover_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enterprise_intelligence_scoring_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_artifact_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_artifact_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_artifact_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_call_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_caption_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_copilot_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_intelligence_consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_intelligence_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_intelligence_job_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_intelligence_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_intelligence_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_media_provider_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_media_quality_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_media_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_meeting_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_memory_candidate_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_memory_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_ownership_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_participant_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_recovery_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_restore_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_risk_blocker_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_speaker_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_timeline_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_topic_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_transcript_processing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_transcription_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_transcription_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.huddle_transcription_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_sync_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intelligence_recalculation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intelligence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_workspace_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_signup_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_intelligence ENABLE ROW LEVEL SECURITY;

-- Verification (expects 0 rows; any row is a table still unprotected):
-- SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
--  ORDER BY c.relname;
