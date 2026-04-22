--
-- PostgreSQL database dump
--

\restrict mcBahjxcUil0GvmvROADAJgxyLxgM4bBCuey9lcqtTdjyBqwnWUKitrIoRzO1f9

-- Dumped from database version 14.22 (Ubuntu 14.22-0ubuntu0.22.04.1)
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_decision_provenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_decision_provenance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    message_id uuid NOT NULL,
    channel_key text,
    explanation text,
    confidence numeric(4,3),
    reasoning jsonb,
    context_used jsonb,
    model text,
    tokens_used integer,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now(),
    trigger_message_id uuid,
    context jsonb
);


--
-- Name: ai_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_memory (
    workspace_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attendance_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    date date NOT NULL,
    signed_in_minutes integer DEFAULT 0,
    available_minutes integer DEFAULT 0,
    aws_minutes integer DEFAULT 0,
    lunch_minutes integer DEFAULT 0,
    screen_on_minutes integer DEFAULT 0,
    screen_off_minutes integer DEFAULT 0,
    recalculated_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE attendance_daily; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.attendance_daily IS 'Daily attendance aggregations calculated from attendance_events table';


--
-- Name: attendance_daily_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_daily_summary (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    date date NOT NULL,
    sign_in_time timestamp without time zone,
    sign_off_time timestamp without time zone,
    total_signed_in_minutes integer DEFAULT 0,
    total_available_minutes integer DEFAULT 0,
    total_aws_minutes integer DEFAULT 0,
    total_lunch_minutes integer DEFAULT 0,
    screen_on_minutes integer DEFAULT 0,
    screen_off_minutes integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: attendance_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    event_type text NOT NULL,
    started_at timestamp without time zone NOT NULL,
    ended_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT attendance_events_event_type_check CHECK ((event_type = ANY (ARRAY['SIGN_IN'::text, 'SIGN_OFF'::text, 'AVAILABLE'::text, 'AWS_START'::text, 'AWS_END'::text, 'LUNCH_START'::text, 'LUNCH_END'::text, 'SCREEN_ON'::text, 'SCREEN_OFF'::text])))
);


--
-- Name: attendance_geo_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_geo_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    office_id uuid,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    distance_from_office_meters integer,
    event_type text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT attendance_geo_logs_event_type_check CHECK ((event_type = ANY (ARRAY['SIGN_IN_ATTEMPT'::text, 'OUT_OF_RADIUS'::text, 'WFH_REQUIRED'::text, 'WFH_APPROVED'::text, 'LOCATION_OK'::text])))
);


--
-- Name: attendance_monthly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_monthly (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    month date NOT NULL,
    signed_in_minutes integer DEFAULT 0,
    available_minutes integer DEFAULT 0,
    aws_minutes integer DEFAULT 0,
    lunch_minutes integer DEFAULT 0,
    screen_on_minutes integer DEFAULT 0,
    screen_off_minutes integer DEFAULT 0,
    recalculated_at timestamp without time zone DEFAULT now()
);


--
-- Name: attendance_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sign_in_at timestamp without time zone NOT NULL,
    sign_off_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    user_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    old_value jsonb,
    new_value jsonb,
    ip_address text,
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid,
    task_id uuid,
    action_type character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    reason text NOT NULL,
    current_state jsonb,
    proposed_changes jsonb,
    confidence_score numeric,
    created_by character varying(20) DEFAULT 'autopilot'::character varying,
    approved_by uuid,
    approved_at timestamp with time zone,
    executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);


--
-- Name: TABLE autopilot_actions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.autopilot_actions IS 'Pending and historical AI-proposed actions requiring approval';


--
-- Name: autopilot_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    action_id uuid NOT NULL,
    decision character varying(20) NOT NULL,
    decision_by uuid,
    decision_at timestamp with time zone DEFAULT now(),
    outcome_status character varying(20),
    outcome_data jsonb,
    user_feedback text,
    effectiveness_score numeric,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE autopilot_decisions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.autopilot_decisions IS 'Audit trail of all autopilot decisions and their outcomes';


--
-- Name: autopilot_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid,
    enabled boolean DEFAULT false,
    mode character varying(20) DEFAULT 'assisted'::character varying,
    auto_assign boolean DEFAULT true,
    auto_deadline_adjust boolean DEFAULT true,
    auto_escalate_blockers boolean DEFAULT true,
    auto_generate_standup boolean DEFAULT true,
    max_tasks_per_user integer DEFAULT 10,
    blocker_threshold_hours integer DEFAULT 48,
    velocity_drop_threshold numeric DEFAULT 0.20,
    require_approval boolean DEFAULT true,
    auto_approve_after_hours integer DEFAULT 24,
    approval_user_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE autopilot_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.autopilot_settings IS 'Configuration for AI Autopilot per workspace/project';


--
-- Name: backup_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_logs (
    id uuid NOT NULL,
    status text NOT NULL,
    triggered_by text DEFAULT 'cron'::text NOT NULL,
    file_name text,
    file_size_bytes bigint,
    storage_type text,
    storage_path text,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_logs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: billing_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(50) NOT NULL,
    tagline character varying(200),
    description text,
    price_monthly_paise integer DEFAULT 0 NOT NULL,
    price_yearly_paise integer DEFAULT 0 NOT NULL,
    yearly_discount_pct smallint DEFAULT 0 NOT NULL,
    member_limit integer DEFAULT 10,
    max_projects integer,
    max_integrations integer,
    storage_limit_gb integer,
    features jsonb DEFAULT '[]'::jsonb NOT NULL,
    support_level character varying(30) DEFAULT 'community'::character varying NOT NULL,
    trial_days smallint DEFAULT 7 NOT NULL,
    grace_period_days smallint DEFAULT 3 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_popular boolean DEFAULT false NOT NULL,
    is_custom boolean DEFAULT false NOT NULL,
    razorpay_monthly_plan_id character varying(100),
    razorpay_yearly_plan_id character varying(100),
    display_order smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: blog_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(100) NOT NULL,
    password character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: blog_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blog_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blog_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blog_users_id_seq OWNED BY public.blog_users.id;


--
-- Name: channel_member_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_member_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    encrypted_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: chat_channel_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_channel_admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    workspace_id uuid
);


--
-- Name: chat_channel_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_channel_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid,
    user_id uuid,
    workspace_id uuid
);


--
-- Name: chat_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_private boolean DEFAULT false,
    description text,
    workspace_id uuid,
    CONSTRAINT chat_channels_workspace_not_null_for_system CHECK (((key <> ALL (ARRAY['availability-updates'::text, 'project-manager'::text, 'general'::text])) OR (workspace_id IS NOT NULL)))
);


--
-- Name: chat_huddles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_huddles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_key text NOT NULL,
    huddle_id text NOT NULL,
    started_by uuid NOT NULL,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    ended_at timestamp without time zone
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_key text,
    user_id uuid,
    text_html text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone,
    deleted_at timestamp without time zone,
    parent_id uuid,
    reactions jsonb DEFAULT '{}'::jsonb,
    attachments jsonb DEFAULT '[]'::jsonb,
    thread_root_id uuid,
    ciphertext text,
    is_encrypted boolean DEFAULT false,
    encrypted_json jsonb,
    sender_public_key jsonb,
    fallback_text text,
    workspace_id uuid,
    temp_id text
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    comment_text text NOT NULL,
    added_by uuid NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    workspace_id uuid
);


--
-- Name: daily_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    date date NOT NULL,
    total_signed_in_minutes integer DEFAULT 0,
    available_minutes integer DEFAULT 0,
    aws_minutes integer DEFAULT 0,
    lunch_minutes integer DEFAULT 0,
    screen_on_minutes integer DEFAULT 0,
    screen_off_minutes integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: dummy_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dummy_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    message text NOT NULL,
    type character varying(50),
    is_read boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: external_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider character varying(50) NOT NULL,
    external_id text NOT NULL,
    entity_type character varying(50) NOT NULL,
    internal_entity_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: gdpr_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gdpr_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    version text NOT NULL,
    consented boolean NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gdpr_erasure_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gdpr_erasure_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    notes text
);


--
-- Name: git_automation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_automation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider text NOT NULL,
    event_type text NOT NULL,
    delivery_id text,
    repo_full_name text,
    branch_name text,
    commit_count integer DEFAULT 0 NOT NULL,
    linked_task_count integer DEFAULT 0 NOT NULL,
    applied_task_count integer DEFAULT 0 NOT NULL,
    skipped_task_count integer DEFAULT 0 NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    result_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: git_project_automation_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_project_automation_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    auto_status_enabled boolean DEFAULT true NOT NULL,
    auto_complete_on_prod boolean DEFAULT false NOT NULL,
    repo_full_name text,
    environment_sequence jsonb DEFAULT '["dev", "qa", "stage", "uat", "prod"]'::jsonb NOT NULL,
    branch_environment_map jsonb DEFAULT '{}'::jsonb NOT NULL,
    require_task_key boolean DEFAULT true NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_infer_tasks boolean DEFAULT true NOT NULL,
    min_inference_confidence integer DEFAULT 62 NOT NULL,
    max_inferred_tasks integer DEFAULT 2 NOT NULL
);


--
-- Name: integration_entity_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_entity_state (
    workspace_id uuid NOT NULL,
    provider text NOT NULL,
    state_hash text NOT NULL,
    updated_at timestamp without time zone DEFAULT now(),
    external_entity_id text NOT NULL
);


--
-- Name: integration_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_state (
    workspace_id uuid NOT NULL,
    provider text NOT NULL,
    state jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: integration_task_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_task_mappings (
    workspace_id uuid NOT NULL,
    provider text NOT NULL,
    external_task_id text NOT NULL,
    internal_task_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: issue_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid,
    name character varying(120) NOT NULL,
    description text,
    default_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: leave_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    leave_type_id uuid NOT NULL,
    year integer DEFAULT EXTRACT(year FROM now()) NOT NULL,
    allocated numeric(5,1) DEFAULT 0 NOT NULL,
    used numeric(5,1) DEFAULT 0 NOT NULL
);


--
-- Name: leave_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    leave_type_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days numeric(4,1) NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by uuid,
    review_note text,
    reviewed_at timestamp with time zone,
    document_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: leave_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6366f1'::text NOT NULL,
    max_days numeric(5,1),
    carry_over boolean DEFAULT false NOT NULL,
    requires_doc boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: magic_link_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.magic_link_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: migration_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migration_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source character varying(50) NOT NULL,
    import_number integer NOT NULL,
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    triggered_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    message text NOT NULL,
    data jsonb,
    is_read boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    task_id uuid,
    project_id uuid,
    comment_id uuid,
    workspace_id uuid
);


--
-- Name: offices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    radius_meters integer DEFAULT 50 NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: okr_key_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.okr_key_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    objective_id uuid NOT NULL,
    title text NOT NULL,
    owner_id uuid,
    type text DEFAULT 'number'::text NOT NULL,
    start_value numeric DEFAULT 0,
    target_value numeric NOT NULL,
    current_value numeric DEFAULT 0,
    unit text,
    due_date date,
    status text DEFAULT 'on_track'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: okr_objectives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.okr_objectives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    owner_id uuid,
    title text NOT NULL,
    description text,
    time_period text NOT NULL,
    status text DEFAULT 'on_track'::text NOT NULL,
    progress numeric(5,2) DEFAULT 0 NOT NULL,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: okr_sprint_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.okr_sprint_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    objective_id uuid NOT NULL,
    sprint_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operations_ai_action_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_ai_action_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    decision text NOT NULL,
    notes text,
    decision_by uuid,
    outcome jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operations_ai_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_ai_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source text DEFAULT 'operations'::text NOT NULL,
    role_scope text DEFAULT 'workspace'::text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    explanation text,
    confidence numeric(4,3),
    risk_level text DEFAULT 'medium'::text NOT NULL,
    action_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    generated_by text DEFAULT 'system'::text NOT NULL,
    created_by uuid,
    approved_by uuid,
    target_user_id uuid,
    project_id uuid,
    task_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    result jsonb,
    approved_at timestamp with time zone,
    executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operations_automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    rule_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    mode text DEFAULT 'assist'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_checkout_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_checkout_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    provider text DEFAULT 'stripe'::text NOT NULL,
    checkout_session_id text NOT NULL,
    customer_id text,
    subscription_id text,
    price_id text,
    billing_plan text,
    status text DEFAULT 'pending'::text NOT NULL,
    success_url text,
    cancel_url text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    customer_id text NOT NULL,
    email text,
    currency text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    provider_event_id text NOT NULL,
    event_type text NOT NULL,
    api_version text,
    livemode boolean DEFAULT false NOT NULL,
    payload jsonb NOT NULL,
    processed_at timestamp with time zone,
    processing_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: performance_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.performance_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    reviewee_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    type text DEFAULT 'manager'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    overall_score numeric(3,1),
    strengths text,
    improvements text,
    goals_next text,
    answers jsonb DEFAULT '[]'::jsonb,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_statuses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    sort_order integer NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_ticket_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_ticket_sequences (
    project_id uuid NOT NULL,
    last_number integer DEFAULT 0 NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    added_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    workspace_id uuid,
    project_code character varying(10),
    wip_limits jsonb DEFAULT '{}'::jsonb
);


--
-- Name: COLUMN projects.wip_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.projects.wip_limits IS 'Per-status WIP limits: {"in-progress": 5}. null value = unlimited.';


--
-- Name: remote_work_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_work_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    request_date date NOT NULL,
    latitude numeric(9,6),
    longitude numeric(9,6),
    reason text,
    status text DEFAULT 'PENDING'::text,
    approved_by uuid,
    approved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT remote_work_requests_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
);


--
-- Name: review_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_cycles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'quarterly'::text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_generated boolean DEFAULT false,
    peer_review_count integer DEFAULT 2,
    reminder_sent_7d boolean DEFAULT false,
    reminder_sent_1d boolean DEFAULT false,
    reminder_sent_3d boolean DEFAULT false
);


--
-- Name: saved_filters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_filters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id uuid,
    name character varying(100) NOT NULL,
    filter_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_shared boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: screen_activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.screen_activity_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    screen_state text NOT NULL,
    started_at timestamp without time zone NOT NULL,
    ended_at timestamp without time zone,
    source text DEFAULT 'visibility_api'::text,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT screen_activity_events_screen_state_check CHECK ((screen_state = ANY (ARRAY['SCREEN_ON'::text, 'SCREEN_OFF'::text])))
);


--
-- Name: sprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sprints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    goal text,
    status character varying(20) DEFAULT 'planning'::character varying NOT NULL,
    start_date date,
    end_date date,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_hidden boolean DEFAULT false NOT NULL,
    CONSTRAINT sprints_status_check CHECK (((status)::text = ANY ((ARRAY['planning'::character varying, 'active'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: TABLE sprints; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sprints IS 'Sprint planning: each sprint belongs to one project. Tasks link via sprint_id (NULL = backlog).';


--
-- Name: subtasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subtasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    title text NOT NULL,
    assignee_id uuid,
    status text DEFAULT 'pending'::text,
    due_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    assigned_to uuid,
    subtask text,
    added_by uuid,
    priority character varying(20) DEFAULT 'medium'::character varying
);


--
-- Name: superadmins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.superadmins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: system_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    email character varying(255),
    username character varying(255) DEFAULT 'AI System'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    display_name text DEFAULT 'AI Assistant'::text,
    type text DEFAULT 'ai'::text
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(80) NOT NULL,
    color character varying(20) DEFAULT '#6366f1'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: task_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_activity_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid,
    action_type character varying(50),
    old_value jsonb,
    new_value jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE task_activity_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.task_activity_logs IS 'Activity log for all task changes - used by AI Strategic Intelligence';


--
-- Name: COLUMN task_activity_logs.action_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_activity_logs.action_type IS 'TASK_CREATED, STATUS_CHANGED, ASSIGNEE_CHANGED, PRIORITY_CHANGED, DESCRIPTION_UPDATED, COMMENT_ADDED, TASK_DELETED';


--
-- Name: COLUMN task_activity_logs.old_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_activity_logs.old_value IS 'Previous state (JSON)';


--
-- Name: COLUMN task_activity_logs.new_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_activity_logs.new_value IS 'New state (JSON)';


--
-- Name: task_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_assignees (
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: task_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    comment_id uuid,
    url text NOT NULL,
    original_name text NOT NULL,
    mime_type text,
    file_size bigint,
    uploaded_by uuid,
    workspace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: task_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_task_id uuid NOT NULL,
    target_task_id uuid NOT NULL,
    link_type character varying(30) NOT NULL,
    workspace_id uuid NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT task_links_link_type_check CHECK (((link_type)::text = ANY ((ARRAY['blocks'::character varying, 'is_blocked_by'::character varying, 'relates_to'::character varying, 'duplicates'::character varying, 'duplicate_of'::character varying, 'parent_of'::character varying, 'child_of'::character varying])::text[])))
);


--
-- Name: task_status_columns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_status_columns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    order_index integer NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT max_status_cols CHECK ((order_index <= 15))
);


--
-- Name: task_tag_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_tag_assignments (
    task_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: task_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_votes (
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: task_watchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_watchers (
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task character varying(500) NOT NULL,
    project_id uuid NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    added_by character varying(255),
    assigned_to uuid,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    due_date date,
    description text,
    priority character varying(20) DEFAULT 'medium'::character varying,
    status_column_id uuid,
    progress numeric DEFAULT 0,
    workspace_id uuid,
    completed_at timestamp without time zone,
    ticket_number integer,
    sprint_id uuid,
    story_points integer,
    task_type character varying(20) DEFAULT 'task'::character varying,
    is_blocked boolean DEFAULT false NOT NULL,
    estimation_hours numeric(6,2),
    CONSTRAINT tasks_task_type_check CHECK (((task_type)::text = ANY ((ARRAY['task'::character varying, 'bug'::character varying, 'feature'::character varying, 'improvement'::character varying, 'chore'::character varying])::text[])))
);


--
-- Name: COLUMN tasks.ticket_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.ticket_number IS 'Auto-incrementing per-project ticket number (e.g. 42 for PROJ-42)';


--
-- Name: COLUMN tasks.sprint_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.sprint_id IS 'NULL = backlog; set to sprint UUID when placed in a sprint';


--
-- Name: COLUMN tasks.story_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.story_points IS 'Effort estimate in story points (Fibonacci: 1,2,3,5,8,13)';


--
-- Name: COLUMN tasks.task_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.task_type IS 'task | bug | feature | improvement | chore';


--
-- Name: COLUMN tasks.is_blocked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.is_blocked IS 'True when task is waiting on something external';


--
-- Name: testing_agent_project_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.testing_agent_project_profiles (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repo_path text,
    framework text,
    commands jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: testing_agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.testing_agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    trigger_source text DEFAULT 'manual'::text NOT NULL,
    mode text DEFAULT 'run'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    generated_cases jsonb DEFAULT '[]'::jsonb NOT NULL,
    commands jsonb DEFAULT '[]'::jsonb NOT NULL,
    output_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: testing_agent_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.testing_agent_settings (
    workspace_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    auto_generate_on_git boolean DEFAULT true NOT NULL,
    auto_run_on_git boolean DEFAULT false NOT NULL,
    max_runtime_seconds integer DEFAULT 900 NOT NULL,
    test_commands jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: time_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    hours numeric(5,2) NOT NULL,
    log_date date DEFAULT CURRENT_DATE NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT time_logs_hours_check CHECK ((hours > (0)::numeric))
);


--
-- Name: trial_fingerprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trial_fingerprints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fingerprint_hash text NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_activation_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_activation_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_ids uuid[] NOT NULL,
    amount_paise integer NOT NULL,
    razorpay_order_id text,
    razorpay_payment_id text,
    razorpay_signature text,
    status character varying(20) DEFAULT 'created'::character varying NOT NULL,
    pro_rated_days integer,
    cycle_start timestamp with time zone,
    cycle_end timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_activation_payments_status_check CHECK (((status)::text = ANY ((ARRAY['created'::character varying, 'paid'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: user_ai_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_ai_preferences (
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    ai_reply_enabled boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_keys (
    user_id uuid NOT NULL,
    public_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_offices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_offices (
    user_id uuid NOT NULL,
    office_id uuid NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id uuid NOT NULL,
    ai_reply_enabled boolean DEFAULT true
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id text NOT NULL,
    refresh_token_hash text NOT NULL,
    ip_address text,
    user_agent text,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_workload_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_workload_view AS
 SELECT t.workspace_id,
    t.assigned_to AS user_id,
    count(*) FILTER (WHERE ((t.status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying])::text[]))) AS active_tasks,
    count(*) FILTER (WHERE (((t.status)::text = 'completed'::text) AND (t.completed_at > (now() - '7 days'::interval)))) AS completed_last_week,
    count(*) FILTER (WHERE ((t.due_date < now()) AND ((t.status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying])::text[])))) AS overdue_tasks,
    avg((EXTRACT(epoch FROM (COALESCE((t.completed_at)::timestamp with time zone, now()) - (t.created_at)::timestamp with time zone)) / (86400)::numeric)) AS avg_completion_days
   FROM public.tasks t
  WHERE (t.assigned_to IS NOT NULL)
  GROUP BY t.workspace_id, t.assigned_to;


--
-- Name: VIEW user_workload_view; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.user_workload_view IS 'Aggregated user workload metrics for auto-assignment decisions';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    added_by character varying(255),
    role character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    password character varying(255),
    project uuid,
    projects uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    password_hash text,
    public_key_jwk jsonb,
    workspace_id uuid,
    is_system boolean DEFAULT false,
    avatar_url text,
    mfa_secret text,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_backup_codes text[]
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id uuid NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    response_status integer,
    response_body text,
    duration_ms integer,
    success boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    secret text,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_fired_at timestamp with time zone,
    failure_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wfh_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wfh_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    date date NOT NULL,
    reason text,
    status text DEFAULT 'PENDING'::text,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT wfh_requests_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
);


--
-- Name: wiki_page_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wiki_page_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    content text NOT NULL,
    title text NOT NULL,
    version integer NOT NULL,
    edited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wiki_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wiki_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    space_id uuid NOT NULL,
    parent_id uuid,
    title text NOT NULL,
    slug text NOT NULL,
    content text DEFAULT ''::text,
    content_text text DEFAULT ''::text,
    icon text,
    cover_url text,
    "position" integer DEFAULT 0 NOT NULL,
    is_published boolean DEFAULT true NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wiki_spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wiki_spaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    icon text DEFAULT '📄'::text,
    is_private boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_admin_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_admin_insights (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    period character varying(10) NOT NULL,
    insight_type character varying(50) NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_ai_settings (
    workspace_id uuid NOT NULL,
    ai_enabled boolean DEFAULT true,
    ai_auto_reply boolean DEFAULT true,
    updated_at timestamp without time zone DEFAULT now(),
    ai_name text DEFAULT 'AI Assistant'::text NOT NULL
);


--
-- Name: workspace_coaching_control; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_coaching_control (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    nudge_type text NOT NULL,
    decision text NOT NULL,
    evaluated_month date NOT NULL,
    metrics jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT workspace_coaching_control_decision_check CHECK ((decision = ANY (ARRAY['boost'::text, 'observe'::text, 'suppress'::text])))
);


--
-- Name: workspace_coaching_effectiveness; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_coaching_effectiveness (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    nudge_id uuid NOT NULL,
    nudge_type character varying(50) NOT NULL,
    baseline_metrics jsonb NOT NULL,
    followup_metrics jsonb NOT NULL,
    score_before integer,
    score_after integer,
    score_delta integer,
    outcome character varying(20),
    evaluated_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_coaching_nudges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_coaching_nudges (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    period character varying(10) NOT NULL,
    nudge_type character varying(50) NOT NULL,
    message text NOT NULL,
    evidence jsonb NOT NULL,
    expected_impact character varying(50),
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_coaching_throttle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_coaching_throttle (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    nudge_type text NOT NULL,
    decision text NOT NULL,
    evaluated_month text NOT NULL,
    metrics jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_coaching_throttle_decision_check CHECK ((decision = ANY (ARRAY['allow'::text, 'boost'::text, 'suppress'::text])))
);


--
-- Name: workspace_digest_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_digest_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    frequency text DEFAULT 'daily'::text NOT NULL,
    delivery_hour smallint DEFAULT 8 NOT NULL,
    channel text DEFAULT 'in_app'::text NOT NULL,
    include_sections jsonb DEFAULT '["priorities", "people", "approvals", "risks"]'::jsonb NOT NULL,
    last_sent_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_digest_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_digest_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_scope text NOT NULL,
    digest_type text DEFAULT 'daily_os'::text NOT NULL,
    delivery_mode text DEFAULT 'preview'::text NOT NULL,
    summary text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'generated'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid,
    event_type character varying(100) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_execution_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_execution_signals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    signal_type text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_executive_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_executive_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    period character varying(10) NOT NULL,
    summary text,
    source_data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    status character varying(20) DEFAULT 'processing'::character varying
);


--
-- Name: workspace_geo_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_geo_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    latitude numeric(9,6) NOT NULL,
    longitude numeric(9,6) NOT NULL,
    radius_meters integer DEFAULT 100 NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: workspace_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_health (
    workspace_id uuid NOT NULL,
    health_score numeric DEFAULT 70,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: workspace_holidays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_holidays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    date date NOT NULL,
    name character varying(200) NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'connected'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    last_synced_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: workspace_llm_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_llm_narratives (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    scope character varying(20) NOT NULL,
    subject_id uuid,
    period character varying(10) NOT NULL,
    narrative text NOT NULL,
    source_data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_memory_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_memory_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    created_by uuid,
    source_entity_type text,
    source_entity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_monthly_role_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_monthly_role_insights (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    role character varying(20) NOT NULL,
    subject_id uuid,
    month character varying(7) NOT NULL,
    insights jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_monthly_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_monthly_scores (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    month character varying(7) NOT NULL,
    score integer NOT NULL,
    breakdown jsonb NOT NULL,
    reasoning jsonb NOT NULL,
    improvements jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: workspace_project_monthly_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_project_monthly_scores (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    month text NOT NULL,
    score integer NOT NULL,
    breakdown jsonb,
    reasoning jsonb,
    created_at timestamp without time zone DEFAULT now(),
    productivity_score numeric(5,2) DEFAULT 0
);


--
-- Name: workspace_recovery_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_recovery_jobs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    status text NOT NULL,
    requested_by text,
    dry_run boolean DEFAULT false NOT NULL,
    batch_size integer DEFAULT 500 NOT NULL,
    source_label text,
    rows_scanned bigint DEFAULT 0 NOT NULL,
    rows_written bigint DEFAULT 0 NOT NULL,
    table_summary jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    progress_pct numeric(6,2) DEFAULT 0 NOT NULL,
    current_table text,
    progress_message text,
    event_log jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_recovery_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: workspace_search_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_search_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    query text NOT NULL,
    normalized_query text NOT NULL,
    result_count integer DEFAULT 0 NOT NULL,
    result_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    searched_at timestamp with time zone DEFAULT now() NOT NULL,
    clicked_result_type text,
    clicked_result_id text,
    clicked_result_title text,
    clicked_result_path text,
    clicked_result_meta jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: workspace_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_settings (
    workspace_id uuid NOT NULL,
    ai_enabled boolean DEFAULT true,
    ai_system_user_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    ai_name text
);


--
-- Name: workspace_short_term_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_short_term_context (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_type character varying(50) NOT NULL,
    subject_id uuid NOT NULL,
    context jsonb NOT NULL,
    last_updated timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_sso_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_sso_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    provider text DEFAULT 'saml'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    entry_point text,
    issuer text,
    cert text,
    sp_callback_url text,
    attribute_email text DEFAULT 'email'::text NOT NULL,
    attribute_name text DEFAULT 'displayName'::text NOT NULL,
    force_sso boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    customer_id text,
    subscription_id text NOT NULL,
    status text DEFAULT 'incomplete'::text NOT NULL,
    billing_plan text,
    price_id text,
    product_id text,
    currency text,
    "interval" text,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    trial_ends_at timestamp with time zone,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    billing_plan_id uuid,
    billing_interval character varying(20) DEFAULT 'monthly'::character varying,
    mandate_id text,
    razorpay_customer_id text,
    auth_amount_paise integer DEFAULT 100,
    auth_refunded boolean DEFAULT false,
    next_billing_at timestamp with time zone,
    grace_period_ends_at timestamp with time zone,
    payment_failure_count smallint DEFAULT 0,
    last_payment_at timestamp with time zone,
    last_payment_id text
);


--
-- Name: workspace_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    manager_id uuid,
    billing_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    activated_at timestamp with time zone,
    cycle_start timestamp with time zone,
    cycle_end timestamp with time zone,
    CONSTRAINT workspace_users_billing_status_check CHECK (((billing_status)::text = ANY ((ARRAY['trial'::character varying, 'active'::character varying, 'pending'::character varying])::text[])))
);


--
-- Name: workspace_work_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_work_schedule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    work_days integer[] DEFAULT ARRAY[1, 2, 3, 4, 5] NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_yearly_performance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_yearly_performance (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    year integer NOT NULL,
    yearly_score integer NOT NULL,
    trends jsonb NOT NULL,
    consistency jsonb NOT NULL,
    reasoning jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text,
    billing_plan text,
    max_members integer DEFAULT 10,
    created_by uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    workspace_uuid uuid DEFAULT gen_random_uuid(),
    owner_user_id uuid,
    plan_id uuid,
    plan text DEFAULT 'basic'::text,
    member_limit integer DEFAULT 10,
    is_active boolean DEFAULT true,
    updated_at timestamp without time zone DEFAULT now(),
    billing_status text,
    billing_provider text,
    billing_customer_id text,
    billing_subscription_id text,
    billing_current_period_end timestamp with time zone,
    billing_updated_at timestamp with time zone,
    trial_started_at timestamp with time zone,
    billing_cycle_anchor timestamp with time zone,
    per_user_price_paise integer,
    status character varying(20) DEFAULT 'active'::character varying,
    trial_ends_at timestamp with time zone
);


--
-- Name: blog_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_users ALTER COLUMN id SET DEFAULT nextval('public.blog_users_id_seq'::regclass);


--
-- Name: ai_decision_provenance ai_decision_provenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_decision_provenance
    ADD CONSTRAINT ai_decision_provenance_pkey PRIMARY KEY (id);


--
-- Name: ai_memory ai_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_memory
    ADD CONSTRAINT ai_memory_pkey PRIMARY KEY (workspace_id, type);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: attendance_daily attendance_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_daily
    ADD CONSTRAINT attendance_daily_pkey PRIMARY KEY (id);


--
-- Name: attendance_daily_summary attendance_daily_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_daily_summary
    ADD CONSTRAINT attendance_daily_summary_pkey PRIMARY KEY (id);


--
-- Name: attendance_daily_summary attendance_daily_summary_user_id_workspace_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_daily_summary
    ADD CONSTRAINT attendance_daily_summary_user_id_workspace_id_date_key UNIQUE (user_id, workspace_id, date);


--
-- Name: attendance_events attendance_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_pkey PRIMARY KEY (id);


--
-- Name: attendance_geo_logs attendance_geo_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_geo_logs
    ADD CONSTRAINT attendance_geo_logs_pkey PRIMARY KEY (id);


--
-- Name: attendance_monthly attendance_monthly_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_monthly
    ADD CONSTRAINT attendance_monthly_pkey PRIMARY KEY (workspace_id, user_id, month);


--
-- Name: attendance_sessions attendance_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: autopilot_actions autopilot_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_actions
    ADD CONSTRAINT autopilot_actions_pkey PRIMARY KEY (id);


--
-- Name: autopilot_decisions autopilot_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_decisions
    ADD CONSTRAINT autopilot_decisions_pkey PRIMARY KEY (id);


--
-- Name: autopilot_settings autopilot_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_settings
    ADD CONSTRAINT autopilot_settings_pkey PRIMARY KEY (id);


--
-- Name: backup_logs backup_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_logs
    ADD CONSTRAINT backup_logs_pkey PRIMARY KEY (id);


--
-- Name: billing_plans billing_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_plans
    ADD CONSTRAINT billing_plans_pkey PRIMARY KEY (id);


--
-- Name: billing_plans billing_plans_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_plans
    ADD CONSTRAINT billing_plans_slug_key UNIQUE (slug);


--
-- Name: blog_users blog_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_users
    ADD CONSTRAINT blog_users_email_key UNIQUE (email);


--
-- Name: blog_users blog_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_users
    ADD CONSTRAINT blog_users_pkey PRIMARY KEY (id);


--
-- Name: channel_member_keys channel_member_keys_channel_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_keys
    ADD CONSTRAINT channel_member_keys_channel_id_user_id_key UNIQUE (channel_id, user_id);


--
-- Name: channel_member_keys channel_member_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_keys
    ADD CONSTRAINT channel_member_keys_pkey PRIMARY KEY (id);


--
-- Name: chat_channel_admins chat_channel_admins_channel_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_admins
    ADD CONSTRAINT chat_channel_admins_channel_id_user_id_key UNIQUE (channel_id, user_id);


--
-- Name: chat_channel_admins chat_channel_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_admins
    ADD CONSTRAINT chat_channel_admins_pkey PRIMARY KEY (id);


--
-- Name: chat_channel_members chat_channel_members_channel_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_members
    ADD CONSTRAINT chat_channel_members_channel_id_user_id_key UNIQUE (channel_id, user_id);


--
-- Name: chat_channel_members chat_channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_members
    ADD CONSTRAINT chat_channel_members_pkey PRIMARY KEY (id);


--
-- Name: chat_channels chat_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channels
    ADD CONSTRAINT chat_channels_pkey PRIMARY KEY (id);


--
-- Name: chat_huddles chat_huddles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_huddles
    ADD CONSTRAINT chat_huddles_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: daily_attendance daily_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_attendance
    ADD CONSTRAINT daily_attendance_pkey PRIMARY KEY (id);


--
-- Name: daily_attendance daily_attendance_workspace_id_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_attendance
    ADD CONSTRAINT daily_attendance_workspace_id_user_id_date_key UNIQUE (workspace_id, user_id, date);


--
-- Name: dummy_notifications dummy_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dummy_notifications
    ADD CONSTRAINT dummy_notifications_pkey PRIMARY KEY (id);


--
-- Name: external_entities external_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_entities
    ADD CONSTRAINT external_entities_pkey PRIMARY KEY (id);


--
-- Name: external_entities external_entities_workspace_id_provider_external_id_entity__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_entities
    ADD CONSTRAINT external_entities_workspace_id_provider_external_id_entity__key UNIQUE (workspace_id, provider, external_id, entity_type);


--
-- Name: gdpr_consents gdpr_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_consents
    ADD CONSTRAINT gdpr_consents_pkey PRIMARY KEY (id);


--
-- Name: gdpr_erasure_requests gdpr_erasure_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_requests
    ADD CONSTRAINT gdpr_erasure_requests_pkey PRIMARY KEY (id);


--
-- Name: git_automation_events git_automation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_automation_events
    ADD CONSTRAINT git_automation_events_pkey PRIMARY KEY (id);


--
-- Name: git_project_automation_settings git_project_automation_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_project_automation_settings
    ADD CONSTRAINT git_project_automation_settings_pkey PRIMARY KEY (id);


--
-- Name: integration_entity_state integration_entity_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_entity_state
    ADD CONSTRAINT integration_entity_state_pkey PRIMARY KEY (workspace_id, provider, external_entity_id);


--
-- Name: integration_state integration_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_state
    ADD CONSTRAINT integration_state_pkey PRIMARY KEY (workspace_id, provider);


--
-- Name: integration_task_mappings integration_task_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_task_mappings
    ADD CONSTRAINT integration_task_mappings_pkey PRIMARY KEY (workspace_id, provider, external_task_id);


--
-- Name: issue_templates issue_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_templates
    ADD CONSTRAINT issue_templates_pkey PRIMARY KEY (id);


--
-- Name: leave_balances leave_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_pkey PRIMARY KEY (id);


--
-- Name: leave_balances leave_balances_workspace_id_user_id_leave_type_id_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_workspace_id_user_id_leave_type_id_year_key UNIQUE (workspace_id, user_id, leave_type_id, year);


--
-- Name: leave_requests leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);


--
-- Name: leave_types leave_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);


--
-- Name: magic_link_tokens magic_link_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_link_tokens
    ADD CONSTRAINT magic_link_tokens_pkey PRIMARY KEY (id);


--
-- Name: magic_link_tokens magic_link_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_link_tokens
    ADD CONSTRAINT magic_link_tokens_token_key UNIQUE (token);


--
-- Name: migration_imports migration_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_imports
    ADD CONSTRAINT migration_imports_pkey PRIMARY KEY (id);


--
-- Name: migration_imports migration_imports_workspace_id_source_import_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_imports
    ADD CONSTRAINT migration_imports_workspace_id_source_import_number_key UNIQUE (workspace_id, source, import_number);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: offices offices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offices
    ADD CONSTRAINT offices_pkey PRIMARY KEY (id);


--
-- Name: okr_key_results okr_key_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_key_results
    ADD CONSTRAINT okr_key_results_pkey PRIMARY KEY (id);


--
-- Name: okr_objectives okr_objectives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_objectives
    ADD CONSTRAINT okr_objectives_pkey PRIMARY KEY (id);


--
-- Name: okr_sprint_links okr_sprint_links_objective_id_sprint_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_sprint_links
    ADD CONSTRAINT okr_sprint_links_objective_id_sprint_id_key UNIQUE (objective_id, sprint_id);


--
-- Name: okr_sprint_links okr_sprint_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_sprint_links
    ADD CONSTRAINT okr_sprint_links_pkey PRIMARY KEY (id);


--
-- Name: operations_ai_action_decisions operations_ai_action_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_action_decisions
    ADD CONSTRAINT operations_ai_action_decisions_pkey PRIMARY KEY (id);


--
-- Name: operations_ai_actions operations_ai_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_pkey PRIMARY KEY (id);


--
-- Name: operations_automation_rules operations_automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_automation_rules
    ADD CONSTRAINT operations_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: operations_automation_rules operations_automation_rules_workspace_id_rule_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_automation_rules
    ADD CONSTRAINT operations_automation_rules_workspace_id_rule_key_key UNIQUE (workspace_id, rule_key);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: payment_checkout_sessions payment_checkout_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checkout_sessions
    ADD CONSTRAINT payment_checkout_sessions_pkey PRIMARY KEY (id);


--
-- Name: payment_checkout_sessions payment_checkout_sessions_provider_checkout_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checkout_sessions
    ADD CONSTRAINT payment_checkout_sessions_provider_checkout_session_id_key UNIQUE (provider, checkout_session_id);


--
-- Name: payment_customers payment_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_pkey PRIMARY KEY (id);


--
-- Name: payment_customers payment_customers_provider_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_provider_customer_id_key UNIQUE (provider, customer_id);


--
-- Name: payment_customers payment_customers_workspace_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_workspace_id_provider_key UNIQUE (workspace_id, provider);


--
-- Name: payment_webhook_events payment_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_events
    ADD CONSTRAINT payment_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: payment_webhook_events payment_webhook_events_provider_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_events
    ADD CONSTRAINT payment_webhook_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);


--
-- Name: performance_reviews performance_reviews_cycle_id_reviewee_id_reviewer_id_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews
    ADD CONSTRAINT performance_reviews_cycle_id_reviewee_id_reviewer_id_type_key UNIQUE (cycle_id, reviewee_id, reviewer_id, type);


--
-- Name: performance_reviews performance_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews
    ADD CONSTRAINT performance_reviews_pkey PRIMARY KEY (id);


--
-- Name: project_statuses project_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_statuses
    ADD CONSTRAINT project_statuses_pkey PRIMARY KEY (id);


--
-- Name: project_ticket_sequences project_ticket_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_ticket_sequences
    ADD CONSTRAINT project_ticket_sequences_pkey PRIMARY KEY (project_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: remote_work_requests remote_work_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_work_requests
    ADD CONSTRAINT remote_work_requests_pkey PRIMARY KEY (id);


--
-- Name: remote_work_requests remote_work_requests_user_id_request_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_work_requests
    ADD CONSTRAINT remote_work_requests_user_id_request_date_key UNIQUE (user_id, request_date);


--
-- Name: review_cycles review_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_cycles
    ADD CONSTRAINT review_cycles_pkey PRIMARY KEY (id);


--
-- Name: saved_filters saved_filters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_filters
    ADD CONSTRAINT saved_filters_pkey PRIMARY KEY (id);


--
-- Name: screen_activity_events screen_activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screen_activity_events
    ADD CONSTRAINT screen_activity_events_pkey PRIMARY KEY (id);


--
-- Name: sprints sprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sprints
    ADD CONSTRAINT sprints_pkey PRIMARY KEY (id);


--
-- Name: subtasks subtasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks
    ADD CONSTRAINT subtasks_pkey PRIMARY KEY (id);


--
-- Name: superadmins superadmins_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmins
    ADD CONSTRAINT superadmins_email_key UNIQUE (email);


--
-- Name: superadmins superadmins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmins
    ADD CONSTRAINT superadmins_pkey PRIMARY KEY (id);


--
-- Name: system_users system_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_users
    ADD CONSTRAINT system_users_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_workspace_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_workspace_id_name_key UNIQUE (workspace_id, name);


--
-- Name: task_activity_logs task_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_activity_logs
    ADD CONSTRAINT task_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: task_assignees task_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_pkey PRIMARY KEY (task_id, user_id);


--
-- Name: task_attachments task_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_pkey PRIMARY KEY (id);


--
-- Name: task_links task_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_pkey PRIMARY KEY (id);


--
-- Name: task_links task_links_source_task_id_target_task_id_link_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_source_task_id_target_task_id_link_type_key UNIQUE (source_task_id, target_task_id, link_type);


--
-- Name: task_status_columns task_status_columns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_status_columns
    ADD CONSTRAINT task_status_columns_pkey PRIMARY KEY (id);


--
-- Name: task_tag_assignments task_tag_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tag_assignments
    ADD CONSTRAINT task_tag_assignments_pkey PRIMARY KEY (task_id, tag_id);


--
-- Name: task_votes task_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_votes
    ADD CONSTRAINT task_votes_pkey PRIMARY KEY (task_id, user_id);


--
-- Name: task_watchers task_watchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_watchers
    ADD CONSTRAINT task_watchers_pkey PRIMARY KEY (task_id, user_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: testing_agent_project_profiles testing_agent_project_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.testing_agent_project_profiles
    ADD CONSTRAINT testing_agent_project_profiles_pkey PRIMARY KEY (workspace_id, project_id);


--
-- Name: testing_agent_runs testing_agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.testing_agent_runs
    ADD CONSTRAINT testing_agent_runs_pkey PRIMARY KEY (id);


--
-- Name: testing_agent_settings testing_agent_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.testing_agent_settings
    ADD CONSTRAINT testing_agent_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: time_logs time_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_logs
    ADD CONSTRAINT time_logs_pkey PRIMARY KEY (id);


--
-- Name: trial_fingerprints trial_fingerprints_fingerprint_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trial_fingerprints
    ADD CONSTRAINT trial_fingerprints_fingerprint_hash_key UNIQUE (fingerprint_hash);


--
-- Name: trial_fingerprints trial_fingerprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trial_fingerprints
    ADD CONSTRAINT trial_fingerprints_pkey PRIMARY KEY (id);


--
-- Name: workspace_project_monthly_scores uniq_user_project_month; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_project_monthly_scores
    ADD CONSTRAINT uniq_user_project_month UNIQUE (workspace_id, project_id, user_id, month);


--
-- Name: workspace_coaching_control uniq_workspace_nudge_month; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coaching_control
    ADD CONSTRAINT uniq_workspace_nudge_month UNIQUE (workspace_id, nudge_type, evaluated_month);


--
-- Name: workspace_monthly_scores uniq_workspace_user_month; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_monthly_scores
    ADD CONSTRAINT uniq_workspace_user_month UNIQUE (workspace_id, user_id, month);


--
-- Name: workspace_project_monthly_scores uniq_workspace_user_project_month; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_project_monthly_scores
    ADD CONSTRAINT uniq_workspace_user_project_month UNIQUE (workspace_id, user_id, project_id, month);


--
-- Name: workspace_users unique_user_workspace; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_users
    ADD CONSTRAINT unique_user_workspace UNIQUE (user_id);


--
-- Name: system_users unique_workspace_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_users
    ADD CONSTRAINT unique_workspace_id UNIQUE (workspace_id);


--
-- Name: workspace_executive_summaries unique_workspace_period; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_executive_summaries
    ADD CONSTRAINT unique_workspace_period UNIQUE (workspace_id, period);


--
-- Name: git_project_automation_settings uq_git_project_automation_settings; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_project_automation_settings
    ADD CONSTRAINT uq_git_project_automation_settings UNIQUE (workspace_id, project_id);


--
-- Name: user_activation_payments user_activation_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activation_payments
    ADD CONSTRAINT user_activation_payments_pkey PRIMARY KEY (id);


--
-- Name: user_ai_preferences user_ai_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_preferences
    ADD CONSTRAINT user_ai_preferences_pkey PRIMARY KEY (user_id, workspace_id);


--
-- Name: user_keys user_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_keys
    ADD CONSTRAINT user_keys_pkey PRIMARY KEY (user_id);


--
-- Name: user_offices user_offices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_offices
    ADD CONSTRAINT user_offices_pkey PRIMARY KEY (user_id, office_id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_refresh_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhooks webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);


--
-- Name: wfh_requests wfh_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wfh_requests
    ADD CONSTRAINT wfh_requests_pkey PRIMARY KEY (id);


--
-- Name: wfh_requests wfh_requests_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wfh_requests
    ADD CONSTRAINT wfh_requests_user_id_date_key UNIQUE (user_id, date);


--
-- Name: wiki_page_versions wiki_page_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_page_versions
    ADD CONSTRAINT wiki_page_versions_pkey PRIMARY KEY (id);


--
-- Name: wiki_pages wiki_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_pages
    ADD CONSTRAINT wiki_pages_pkey PRIMARY KEY (id);


--
-- Name: wiki_pages wiki_pages_space_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_pages
    ADD CONSTRAINT wiki_pages_space_id_slug_key UNIQUE (space_id, slug);


--
-- Name: wiki_spaces wiki_spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_spaces
    ADD CONSTRAINT wiki_spaces_pkey PRIMARY KEY (id);


--
-- Name: wiki_spaces wiki_spaces_workspace_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_spaces
    ADD CONSTRAINT wiki_spaces_workspace_id_slug_key UNIQUE (workspace_id, slug);


--
-- Name: workspace_admin_insights workspace_admin_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_admin_insights
    ADD CONSTRAINT workspace_admin_insights_pkey PRIMARY KEY (id);


--
-- Name: workspace_ai_settings workspace_ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_ai_settings
    ADD CONSTRAINT workspace_ai_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_coaching_control workspace_coaching_control_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coaching_control
    ADD CONSTRAINT workspace_coaching_control_pkey PRIMARY KEY (id);


--
-- Name: workspace_coaching_effectiveness workspace_coaching_effectiveness_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coaching_effectiveness
    ADD CONSTRAINT workspace_coaching_effectiveness_pkey PRIMARY KEY (id);


--
-- Name: workspace_coaching_nudges workspace_coaching_nudges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coaching_nudges
    ADD CONSTRAINT workspace_coaching_nudges_pkey PRIMARY KEY (id);


--
-- Name: workspace_coaching_throttle workspace_coaching_throttle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coaching_throttle
    ADD CONSTRAINT workspace_coaching_throttle_pkey PRIMARY KEY (id);


--
-- Name: workspace_coaching_throttle workspace_coaching_throttle_workspace_id_nudge_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coaching_throttle
    ADD CONSTRAINT workspace_coaching_throttle_workspace_id_nudge_type_key UNIQUE (workspace_id, nudge_type);


--
-- Name: workspace_digest_preferences workspace_digest_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_preferences
    ADD CONSTRAINT workspace_digest_preferences_pkey PRIMARY KEY (id);


--
-- Name: workspace_digest_preferences workspace_digest_preferences_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_preferences
    ADD CONSTRAINT workspace_digest_preferences_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: workspace_digest_runs workspace_digest_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_runs
    ADD CONSTRAINT workspace_digest_runs_pkey PRIMARY KEY (id);


--
-- Name: workspace_events workspace_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_events
    ADD CONSTRAINT workspace_events_pkey PRIMARY KEY (id);


--
-- Name: workspace_execution_signals workspace_execution_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_execution_signals
    ADD CONSTRAINT workspace_execution_signals_pkey PRIMARY KEY (id);


--
-- Name: workspace_executive_summaries workspace_executive_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_executive_summaries
    ADD CONSTRAINT workspace_executive_summaries_pkey PRIMARY KEY (id);


--
-- Name: workspace_geo_rules workspace_geo_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_geo_rules
    ADD CONSTRAINT workspace_geo_rules_pkey PRIMARY KEY (id);


--
-- Name: workspace_health workspace_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_health
    ADD CONSTRAINT workspace_health_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_holidays workspace_holidays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_holidays
    ADD CONSTRAINT workspace_holidays_pkey PRIMARY KEY (id);


--
-- Name: workspace_holidays workspace_holidays_workspace_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_holidays
    ADD CONSTRAINT workspace_holidays_workspace_id_date_key UNIQUE (workspace_id, date);


--
-- Name: workspace_integrations workspace_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_integrations
    ADD CONSTRAINT workspace_integrations_pkey PRIMARY KEY (id);


--
-- Name: workspace_integrations workspace_integrations_workspace_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_integrations
    ADD CONSTRAINT workspace_integrations_workspace_id_provider_key UNIQUE (workspace_id, provider);


--
-- Name: workspace_llm_narratives workspace_llm_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_llm_narratives
    ADD CONSTRAINT workspace_llm_narratives_pkey PRIMARY KEY (id);


--
-- Name: workspace_memory_entries workspace_memory_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memory_entries
    ADD CONSTRAINT workspace_memory_entries_pkey PRIMARY KEY (id);


--
-- Name: workspace_monthly_role_insights workspace_monthly_role_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_monthly_role_insights
    ADD CONSTRAINT workspace_monthly_role_insights_pkey PRIMARY KEY (id);


--
-- Name: workspace_monthly_scores workspace_monthly_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_monthly_scores
    ADD CONSTRAINT workspace_monthly_scores_pkey PRIMARY KEY (id);


--
-- Name: workspace_project_monthly_scores workspace_project_monthly_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_project_monthly_scores
    ADD CONSTRAINT workspace_project_monthly_scores_pkey PRIMARY KEY (id);


--
-- Name: workspace_recovery_jobs workspace_recovery_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_recovery_jobs
    ADD CONSTRAINT workspace_recovery_jobs_pkey PRIMARY KEY (id);


--
-- Name: workspace_search_history workspace_search_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_search_history
    ADD CONSTRAINT workspace_search_history_pkey PRIMARY KEY (id);


--
-- Name: workspace_settings workspace_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_short_term_context workspace_short_term_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_short_term_context
    ADD CONSTRAINT workspace_short_term_context_pkey PRIMARY KEY (id);


--
-- Name: workspace_short_term_context workspace_short_term_context_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_short_term_context
    ADD CONSTRAINT workspace_short_term_context_unique UNIQUE (workspace_id, subject_id, subject_type);


--
-- Name: workspace_sso_configs workspace_sso_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sso_configs
    ADD CONSTRAINT workspace_sso_configs_pkey PRIMARY KEY (id);


--
-- Name: workspace_sso_configs workspace_sso_configs_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sso_configs
    ADD CONSTRAINT workspace_sso_configs_workspace_id_key UNIQUE (workspace_id);


--
-- Name: workspace_subscriptions workspace_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: workspace_subscriptions workspace_subscriptions_provider_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_provider_subscription_id_key UNIQUE (provider, subscription_id);


--
-- Name: workspace_subscriptions workspace_subscriptions_workspace_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_workspace_id_provider_key UNIQUE (workspace_id, provider);


--
-- Name: workspace_users workspace_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_users
    ADD CONSTRAINT workspace_users_pkey PRIMARY KEY (id);


--
-- Name: workspace_users workspace_users_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_users
    ADD CONSTRAINT workspace_users_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: workspace_work_schedule workspace_work_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_work_schedule
    ADD CONSTRAINT workspace_work_schedule_pkey PRIMARY KEY (id);


--
-- Name: workspace_work_schedule workspace_work_schedule_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_work_schedule
    ADD CONSTRAINT workspace_work_schedule_workspace_id_key UNIQUE (workspace_id);


--
-- Name: workspace_yearly_performance workspace_yearly_performance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_yearly_performance
    ADD CONSTRAINT workspace_yearly_performance_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);


--
-- Name: chat_channels_workspace_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_channels_workspace_key_unique ON public.chat_channels USING btree (workspace_id, key);


--
-- Name: idx_admin_insights_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_insights_lookup ON public.workspace_admin_insights USING btree (workspace_id, period, insight_type);


--
-- Name: idx_ai_prov_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_prov_message ON public.ai_decision_provenance USING btree (message_id);


--
-- Name: idx_ai_prov_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_prov_workspace ON public.ai_decision_provenance USING btree (workspace_id);


--
-- Name: idx_ai_provenance_context; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_provenance_context ON public.ai_decision_provenance USING gin (context);


--
-- Name: idx_ai_provenance_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_provenance_message ON public.ai_decision_provenance USING btree (message_id);


--
-- Name: idx_ai_provenance_trigger_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_provenance_trigger_message ON public.ai_decision_provenance USING btree (trigger_message_id);


--
-- Name: idx_ai_provenance_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_provenance_workspace ON public.ai_decision_provenance USING btree (workspace_id);


--
-- Name: idx_api_keys_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_prefix ON public.api_keys USING btree (key_prefix);


--
-- Name: idx_api_keys_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_workspace ON public.api_keys USING btree (workspace_id);


--
-- Name: idx_attendance_daily_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_daily_date ON public.attendance_daily USING btree (date);


--
-- Name: idx_attendance_daily_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_attendance_daily_unique ON public.attendance_daily USING btree (workspace_id, user_id, date);


--
-- Name: idx_attendance_daily_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_daily_user_id ON public.attendance_daily USING btree (user_id);


--
-- Name: idx_attendance_daily_workspace_date_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_daily_workspace_date_user ON public.attendance_daily USING btree (workspace_id, date, user_id);


--
-- Name: idx_attendance_daily_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_daily_workspace_id ON public.attendance_daily USING btree (workspace_id);


--
-- Name: idx_attendance_daily_workspace_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_daily_workspace_user ON public.attendance_daily USING btree (workspace_id, user_id);


--
-- Name: idx_audit_logs_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_entity ON public.audit_logs USING btree (entity_type, entity_id);


--
-- Name: idx_audit_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_user ON public.audit_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_audit_logs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_workspace ON public.audit_logs USING btree (workspace_id, created_at DESC);


--
-- Name: idx_autopilot_actions_dedupe_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_dedupe_window ON public.autopilot_actions USING btree (workspace_id, project_id, task_id, action_type, status, created_at DESC);


--
-- Name: idx_autopilot_actions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_expires ON public.autopilot_actions USING btree (expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_autopilot_actions_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_pending ON public.autopilot_actions USING btree (workspace_id, status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_autopilot_actions_pending_workspace_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_pending_workspace_expires ON public.autopilot_actions USING btree (workspace_id, status, expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_autopilot_actions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_status ON public.autopilot_actions USING btree (status);


--
-- Name: idx_autopilot_actions_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_workspace ON public.autopilot_actions USING btree (workspace_id);


--
-- Name: idx_autopilot_decisions_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_decisions_action ON public.autopilot_decisions USING btree (action_id);


--
-- Name: idx_autopilot_decisions_effectiveness; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_decisions_effectiveness ON public.autopilot_decisions USING btree (effectiveness_score) WHERE (effectiveness_score IS NOT NULL);


--
-- Name: idx_autopilot_decisions_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_decisions_workspace ON public.autopilot_decisions USING btree (workspace_id);


--
-- Name: idx_autopilot_settings_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_settings_project ON public.autopilot_settings USING btree (project_id);


--
-- Name: idx_autopilot_settings_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_autopilot_settings_unique ON public.autopilot_settings USING btree (workspace_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: idx_autopilot_settings_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_settings_workspace ON public.autopilot_settings USING btree (workspace_id);


--
-- Name: idx_backup_logs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_logs_started_at ON public.backup_logs USING btree (started_at DESC);


--
-- Name: idx_billing_plans_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_plans_active ON public.billing_plans USING btree (is_active, display_order);


--
-- Name: idx_channel_admins_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_admins_channel ON public.chat_channel_admins USING btree (channel_id);


--
-- Name: idx_chat_channels_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_channels_workspace_id ON public.chat_channels USING btree (workspace_id);


--
-- Name: idx_chat_huddles_channel_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_huddles_channel_key ON public.chat_huddles USING btree (channel_key);


--
-- Name: idx_chat_messages_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_chat_messages_dedup ON public.chat_messages USING btree (workspace_id, temp_id) WHERE (temp_id IS NOT NULL);


--
-- Name: idx_chat_messages_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_workspace_id ON public.chat_messages USING btree (workspace_id);


--
-- Name: idx_coaching_effectiveness_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_effectiveness_lookup ON public.workspace_coaching_effectiveness USING btree (workspace_id, user_id, nudge_type);


--
-- Name: idx_coaching_nudges_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_nudges_lookup ON public.workspace_coaching_nudges USING btree (workspace_id, user_id, period);


--
-- Name: idx_comments_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_workspace_id ON public.comments USING btree (workspace_id);


--
-- Name: idx_daily_attendance_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_attendance_date ON public.daily_attendance USING btree (date);


--
-- Name: idx_daily_attendance_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_attendance_user ON public.daily_attendance USING btree (user_id);


--
-- Name: idx_daily_attendance_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_attendance_workspace ON public.daily_attendance USING btree (workspace_id);


--
-- Name: idx_exec_summary_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exec_summary_lookup ON public.workspace_executive_summaries USING btree (workspace_id, period);


--
-- Name: idx_git_automation_events_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_automation_events_workspace_created ON public.git_automation_events USING btree (workspace_id, created_at DESC);


--
-- Name: idx_git_project_automation_workspace_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_project_automation_workspace_project ON public.git_project_automation_settings USING btree (workspace_id, project_id);


--
-- Name: idx_holidays_workspace_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_holidays_workspace_date ON public.workspace_holidays USING btree (workspace_id, date);


--
-- Name: idx_leave_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_status ON public.leave_requests USING btree (status);


--
-- Name: idx_leave_requests_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_user ON public.leave_requests USING btree (user_id);


--
-- Name: idx_leave_requests_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_workspace ON public.leave_requests USING btree (workspace_id);


--
-- Name: idx_llm_narratives_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_llm_narratives_lookup ON public.workspace_llm_narratives USING btree (workspace_id, scope, subject_id, period);


--
-- Name: idx_magic_link_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_link_tokens_token ON public.magic_link_tokens USING btree (token);


--
-- Name: idx_magic_link_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_link_tokens_user_id ON public.magic_link_tokens USING btree (user_id);


--
-- Name: idx_migration_imports_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_migration_imports_workspace ON public.migration_imports USING btree (workspace_id, source, created_at DESC);


--
-- Name: idx_monthly_scores_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monthly_scores_lookup ON public.workspace_monthly_scores USING btree (workspace_id, user_id, month);


--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at DESC);


--
-- Name: idx_notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_unread ON public.notifications USING btree (user_id, is_read) WHERE (is_read = false);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: idx_notifications_user_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_workspace ON public.notifications USING btree (user_id, workspace_id);


--
-- Name: idx_notifications_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_workspace_id ON public.notifications USING btree (workspace_id);


--
-- Name: idx_okr_key_results_obj; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_okr_key_results_obj ON public.okr_key_results USING btree (objective_id);


--
-- Name: idx_okr_objectives_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_okr_objectives_workspace ON public.okr_objectives USING btree (workspace_id);


--
-- Name: idx_okr_sprint_links_obj; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_okr_sprint_links_obj ON public.okr_sprint_links USING btree (objective_id);


--
-- Name: idx_okr_sprint_links_sprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_okr_sprint_links_sprint ON public.okr_sprint_links USING btree (sprint_id);


--
-- Name: idx_operations_ai_action_decisions_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operations_ai_action_decisions_action ON public.operations_ai_action_decisions USING btree (action_id, created_at DESC);


--
-- Name: idx_operations_ai_actions_target_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operations_ai_actions_target_user ON public.operations_ai_actions USING btree (target_user_id, created_at DESC);


--
-- Name: idx_operations_ai_actions_workspace_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operations_ai_actions_workspace_status ON public.operations_ai_actions USING btree (workspace_id, status, created_at DESC);


--
-- Name: idx_operations_automation_rules_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operations_automation_rules_workspace ON public.operations_automation_rules USING btree (workspace_id, enabled);


--
-- Name: idx_payment_checkout_sessions_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_checkout_sessions_workspace ON public.payment_checkout_sessions USING btree (workspace_id, created_at DESC);


--
-- Name: idx_payment_customers_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_customers_workspace ON public.payment_customers USING btree (workspace_id, provider);


--
-- Name: idx_payment_webhook_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_webhook_events_type ON public.payment_webhook_events USING btree (event_type, created_at DESC);


--
-- Name: idx_perf_reviews_cycle_missed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perf_reviews_cycle_missed ON public.performance_reviews USING btree (cycle_id, type, status) WHERE (status = 'missed'::text);


--
-- Name: idx_perf_reviews_missed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perf_reviews_missed ON public.performance_reviews USING btree (reviewee_id, type, status) WHERE (status = 'missed'::text);


--
-- Name: idx_projects_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_workspace ON public.projects USING btree (workspace_id);


--
-- Name: idx_projects_workspace_added_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_workspace_added_by ON public.projects USING btree (workspace_id, added_by, created_at DESC);


--
-- Name: idx_projects_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_workspace_id ON public.projects USING btree (workspace_id);


--
-- Name: idx_prt_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prt_token_hash ON public.password_reset_tokens USING btree (token_hash);


--
-- Name: idx_prt_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prt_user_id ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_review_cycles_cron; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_cycles_cron ON public.review_cycles USING btree (status, start_date, end_date);


--
-- Name: idx_reviews_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_cycle ON public.performance_reviews USING btree (cycle_id);


--
-- Name: idx_reviews_reviewee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewee ON public.performance_reviews USING btree (reviewee_id);


--
-- Name: idx_reviews_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewer ON public.performance_reviews USING btree (reviewer_id);


--
-- Name: idx_role_insights_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_insights_lookup ON public.workspace_monthly_role_insights USING btree (workspace_id, role, subject_id, month);


--
-- Name: idx_saved_filters_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_filters_user ON public.saved_filters USING btree (user_id);


--
-- Name: idx_saved_filters_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_filters_workspace ON public.saved_filters USING btree (workspace_id);


--
-- Name: idx_short_term_context_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_short_term_context_lookup ON public.workspace_short_term_context USING btree (workspace_id, subject_type, subject_id);


--
-- Name: idx_sprints_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sprints_project_id ON public.sprints USING btree (project_id);


--
-- Name: idx_sprints_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sprints_status ON public.sprints USING btree (project_id, status);


--
-- Name: idx_sprints_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sprints_workspace_id ON public.sprints USING btree (workspace_id);


--
-- Name: idx_tags_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_workspace ON public.tags USING btree (workspace_id);


--
-- Name: idx_task_activity_logs_action_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_activity_logs_action_type ON public.task_activity_logs USING btree (action_type);


--
-- Name: idx_task_activity_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_activity_logs_created_at ON public.task_activity_logs USING btree (created_at DESC);


--
-- Name: idx_task_activity_logs_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_activity_logs_task_id ON public.task_activity_logs USING btree (task_id);


--
-- Name: idx_task_activity_logs_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_activity_logs_workspace_created ON public.task_activity_logs USING btree (workspace_id, created_at DESC);


--
-- Name: idx_task_activity_logs_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_activity_logs_workspace_id ON public.task_activity_logs USING btree (workspace_id);


--
-- Name: idx_task_assignees_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignees_task ON public.task_assignees USING btree (task_id);


--
-- Name: idx_task_assignees_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignees_user ON public.task_assignees USING btree (user_id);


--
-- Name: idx_task_attachments_comment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_attachments_comment_id ON public.task_attachments USING btree (comment_id) WHERE (comment_id IS NOT NULL);


--
-- Name: idx_task_attachments_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_attachments_task_id ON public.task_attachments USING btree (task_id);


--
-- Name: idx_task_attachments_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_attachments_workspace ON public.task_attachments USING btree (workspace_id);


--
-- Name: idx_task_links_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_links_source ON public.task_links USING btree (source_task_id);


--
-- Name: idx_task_links_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_links_target ON public.task_links USING btree (target_task_id);


--
-- Name: idx_task_links_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_links_workspace ON public.task_links USING btree (workspace_id);


--
-- Name: idx_task_logs_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_logs_task ON public.task_activity_logs USING btree (task_id);


--
-- Name: idx_task_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_tags_tag ON public.task_tag_assignments USING btree (tag_id);


--
-- Name: idx_task_tags_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_tags_task ON public.task_tag_assignments USING btree (task_id);


--
-- Name: idx_task_votes_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_votes_task ON public.task_votes USING btree (task_id);


--
-- Name: idx_task_watchers_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_watchers_task ON public.task_watchers USING btree (task_id);


--
-- Name: idx_task_watchers_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_watchers_user ON public.task_watchers USING btree (user_id);


--
-- Name: idx_tasks_is_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_is_blocked ON public.tasks USING btree (project_id, is_blocked) WHERE (is_blocked = true);


--
-- Name: idx_tasks_sprint_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_sprint_id ON public.tasks USING btree (sprint_id);


--
-- Name: idx_tasks_task_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_task_type ON public.tasks USING btree (project_id, task_type);


--
-- Name: idx_tasks_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace ON public.tasks USING btree (workspace_id);


--
-- Name: idx_tasks_workspace_assigned_project_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_assigned_project_status ON public.tasks USING btree (workspace_id, assigned_to, project_id, status);


--
-- Name: idx_tasks_workspace_assigned_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_assigned_status ON public.tasks USING btree (workspace_id, assigned_to, status);


--
-- Name: idx_tasks_workspace_due_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_due_active ON public.tasks USING btree (workspace_id, due_date) WHERE ((due_date IS NOT NULL) AND ((status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying])::text[])));


--
-- Name: idx_tasks_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_id ON public.tasks USING btree (workspace_id);


--
-- Name: idx_tasks_workspace_project_assigned_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_project_assigned_status ON public.tasks USING btree (workspace_id, project_id, assigned_to, status);


--
-- Name: idx_tasks_workspace_project_due_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_project_due_active ON public.tasks USING btree (workspace_id, project_id, due_date) WHERE ((due_date IS NOT NULL) AND ((status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying])::text[])));


--
-- Name: idx_tasks_workspace_project_status_due_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_project_status_due_assigned ON public.tasks USING btree (workspace_id, project_id, status, due_date, assigned_to);


--
-- Name: idx_tasks_workspace_project_updated_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_project_updated_active ON public.tasks USING btree (workspace_id, project_id, updated_at) WHERE ((status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying])::text[]));


--
-- Name: idx_tasks_workspace_updated_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_workspace_updated_active ON public.tasks USING btree (workspace_id, updated_at) WHERE ((status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying])::text[]));


--
-- Name: idx_templates_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_project ON public.issue_templates USING btree (project_id);


--
-- Name: idx_templates_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_workspace ON public.issue_templates USING btree (workspace_id);


--
-- Name: idx_testing_agent_project_profiles_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_testing_agent_project_profiles_workspace ON public.testing_agent_project_profiles USING btree (workspace_id, project_id);


--
-- Name: idx_testing_agent_runs_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_testing_agent_runs_workspace_created ON public.testing_agent_runs USING btree (workspace_id, created_at DESC);


--
-- Name: idx_testing_agent_runs_workspace_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_testing_agent_runs_workspace_task ON public.testing_agent_runs USING btree (workspace_id, task_id, created_at DESC);


--
-- Name: idx_tf_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tf_hash ON public.trial_fingerprints USING btree (fingerprint_hash);


--
-- Name: idx_time_logs_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_logs_task ON public.time_logs USING btree (task_id);


--
-- Name: idx_time_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_logs_user ON public.time_logs USING btree (user_id);


--
-- Name: idx_time_logs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_logs_workspace ON public.time_logs USING btree (workspace_id);


--
-- Name: idx_user_activation_payments_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_activation_payments_workspace ON public.user_activation_payments USING btree (workspace_id, created_at DESC);


--
-- Name: idx_user_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_expires ON public.user_sessions USING btree (expires_at);


--
-- Name: idx_user_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_token ON public.user_sessions USING btree (refresh_token_hash);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_users_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_workspace_id ON public.users USING btree (workspace_id);


--
-- Name: idx_webhook_deliveries_webhook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_webhook ON public.webhook_deliveries USING btree (webhook_id, created_at DESC);


--
-- Name: idx_webhooks_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhooks_workspace ON public.webhooks USING btree (workspace_id);


--
-- Name: idx_wfh_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wfh_active ON public.wfh_requests USING btree (user_id, workspace_id) WHERE (status = 'APPROVED'::text);


--
-- Name: idx_wiki_pages_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wiki_pages_content ON public.wiki_pages USING gin (to_tsvector('english'::regconfig, content_text));


--
-- Name: idx_wiki_pages_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wiki_pages_parent ON public.wiki_pages USING btree (parent_id);


--
-- Name: idx_wiki_pages_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wiki_pages_space ON public.wiki_pages USING btree (space_id);


--
-- Name: idx_work_schedule_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_work_schedule_workspace ON public.workspace_work_schedule USING btree (workspace_id);


--
-- Name: idx_workspace_digest_runs_workspace_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_digest_runs_workspace_user ON public.workspace_digest_runs USING btree (workspace_id, user_id, created_at DESC);


--
-- Name: idx_workspace_events_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_events_entity ON public.workspace_events USING btree (entity_type, entity_id);


--
-- Name: idx_workspace_events_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_events_event_type ON public.workspace_events USING btree (event_type);


--
-- Name: idx_workspace_events_workspace_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_events_workspace_time ON public.workspace_events USING btree (workspace_id, created_at DESC);


--
-- Name: idx_workspace_memory_entries_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_memory_entries_scope ON public.workspace_memory_entries USING btree (workspace_id, visibility, is_archived, created_at DESC);


--
-- Name: idx_workspace_memory_entries_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_memory_entries_tags ON public.workspace_memory_entries USING gin (tags);


--
-- Name: idx_workspace_monthly_scores_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_monthly_scores_scope ON public.workspace_monthly_scores USING btree (workspace_id, month, user_id);


--
-- Name: idx_workspace_project_monthly_scores_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_project_monthly_scores_scope ON public.workspace_project_monthly_scores USING btree (workspace_id, month, project_id, user_id);


--
-- Name: idx_workspace_recovery_jobs_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_recovery_jobs_status_created ON public.workspace_recovery_jobs USING btree (status, created_at DESC);


--
-- Name: idx_workspace_recovery_jobs_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_recovery_jobs_workspace_created ON public.workspace_recovery_jobs USING btree (workspace_id, created_at DESC);


--
-- Name: idx_workspace_search_history_clicked_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_search_history_clicked_path ON public.workspace_search_history USING btree (workspace_id, user_id, clicked_result_path, searched_at DESC);


--
-- Name: idx_workspace_search_history_normalized_query; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_search_history_normalized_query ON public.workspace_search_history USING btree (workspace_id, user_id, normalized_query, searched_at DESC);


--
-- Name: idx_workspace_search_history_scope_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_search_history_scope_time ON public.workspace_search_history USING btree (workspace_id, user_id, searched_at DESC);


--
-- Name: idx_workspace_subscriptions_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_subscriptions_workspace ON public.workspace_subscriptions USING btree (workspace_id, provider);


--
-- Name: idx_workspace_users_billing_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_users_billing_status ON public.workspace_users USING btree (workspace_id, billing_status);


--
-- Name: idx_workspace_users_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_users_manager ON public.workspace_users USING btree (workspace_id, manager_id) WHERE (manager_id IS NOT NULL);


--
-- Name: idx_workspace_users_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_users_user_id ON public.workspace_users USING btree (user_id);


--
-- Name: idx_workspace_users_user_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_workspace_users_user_id_unique ON public.workspace_users USING btree (user_id);


--
-- Name: idx_workspace_users_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_users_workspace_id ON public.workspace_users USING btree (workspace_id);


--
-- Name: idx_workspaces_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_created_by ON public.workspaces USING btree (created_by);


--
-- Name: idx_workspaces_owner_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_owner_user_id ON public.workspaces USING btree (owner_user_id);


--
-- Name: idx_workspaces_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_workspaces_slug ON public.workspaces USING btree (lower(slug));


--
-- Name: idx_workspaces_workspace_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_workspaces_workspace_uuid ON public.workspaces USING btree (workspace_uuid);


--
-- Name: idx_ws_sub_billing_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ws_sub_billing_plan ON public.workspace_subscriptions USING btree (billing_plan_id);


--
-- Name: idx_yearly_performance_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_yearly_performance_lookup ON public.workspace_yearly_performance USING btree (workspace_id, user_id, year);


--
-- Name: project_statuses_project_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX project_statuses_project_key_idx ON public.project_statuses USING btree (project_id, key);


--
-- Name: system_users_workspace_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX system_users_workspace_unique ON public.system_users USING btree (workspace_id);


--
-- Name: uniq_chat_channels_per_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_chat_channels_per_workspace ON public.chat_channels USING btree (workspace_id, key);


--
-- Name: uniq_open_session; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_open_session ON public.attendance_sessions USING btree (user_id, workspace_id) WHERE (sign_off_at IS NULL);


--
-- Name: uniq_system_user_per_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_system_user_per_workspace ON public.system_users USING btree (workspace_id);


--
-- Name: unique_channel_per_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_channel_per_workspace ON public.chat_channels USING btree (workspace_id, key);


--
-- Name: unique_project_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_project_ticket ON public.tasks USING btree (project_id, ticket_number);


--
-- Name: uq_git_automation_events_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_git_automation_events_delivery ON public.git_automation_events USING btree (provider, delivery_id) WHERE (delivery_id IS NOT NULL);


--
-- Name: ux_system_users_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_system_users_workspace ON public.system_users USING btree (workspace_id);


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: attendance_daily_summary attendance_daily_summary_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_daily_summary
    ADD CONSTRAINT attendance_daily_summary_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: attendance_daily_summary attendance_daily_summary_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_daily_summary
    ADD CONSTRAINT attendance_daily_summary_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: attendance_events attendance_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.attendance_sessions(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: attendance_events attendance_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: attendance_events attendance_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_events
    ADD CONSTRAINT attendance_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: attendance_geo_logs attendance_geo_logs_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_geo_logs
    ADD CONSTRAINT attendance_geo_logs_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id);


--
-- Name: attendance_geo_logs attendance_geo_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_geo_logs
    ADD CONSTRAINT attendance_geo_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: attendance_geo_logs attendance_geo_logs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_geo_logs
    ADD CONSTRAINT attendance_geo_logs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: attendance_sessions attendance_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: attendance_sessions attendance_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: channel_member_keys channel_member_keys_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_keys
    ADD CONSTRAINT channel_member_keys_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.chat_channels(id) ON DELETE CASCADE;


--
-- Name: channel_member_keys channel_member_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_keys
    ADD CONSTRAINT channel_member_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_channel_admins chat_channel_admins_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_admins
    ADD CONSTRAINT chat_channel_admins_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.chat_channels(id) ON DELETE CASCADE;


--
-- Name: chat_channel_admins chat_channel_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_admins
    ADD CONSTRAINT chat_channel_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_channel_members chat_channel_members_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_members
    ADD CONSTRAINT chat_channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.chat_channels(id) ON DELETE CASCADE;


--
-- Name: chat_channel_members chat_channel_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channel_members
    ADD CONSTRAINT chat_channel_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: chat_channels chat_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channels
    ADD CONSTRAINT chat_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: chat_channels chat_channels_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channels
    ADD CONSTRAINT chat_channels_workspace_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: chat_huddles chat_huddles_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_huddles
    ADD CONSTRAINT chat_huddles_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: comments comments_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: comments comments_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_workspace_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: dummy_notifications dummy_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dummy_notifications
    ADD CONSTRAINT dummy_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: autopilot_decisions fk_action; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_decisions
    ADD CONSTRAINT fk_action FOREIGN KEY (action_id) REFERENCES public.autopilot_actions(id) ON DELETE CASCADE;


--
-- Name: tasks fk_assigned_to; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT fk_assigned_to FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: git_project_automation_settings fk_git_project_automation_project; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_project_automation_settings
    ADD CONSTRAINT fk_git_project_automation_project FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: chat_messages fk_message_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT fk_message_parent FOREIGN KEY (parent_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE;


--
-- Name: tasks fk_project_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT fk_project_id FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: autopilot_actions fk_task; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_actions
    ADD CONSTRAINT fk_task FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: testing_agent_project_profiles fk_testing_profile_project; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.testing_agent_project_profiles
    ADD CONSTRAINT fk_testing_profile_project FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: testing_agent_runs fk_testing_runs_task; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.testing_agent_runs
    ADD CONSTRAINT fk_testing_runs_task FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: users fk_users_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: autopilot_actions fk_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_actions
    ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: autopilot_decisions fk_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_decisions
    ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: autopilot_settings fk_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_settings
    ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: gdpr_consents gdpr_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_consents
    ADD CONSTRAINT gdpr_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: gdpr_erasure_requests gdpr_erasure_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_requests
    ADD CONSTRAINT gdpr_erasure_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: gdpr_erasure_requests gdpr_erasure_requests_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_requests
    ADD CONSTRAINT gdpr_erasure_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: issue_templates issue_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_templates
    ADD CONSTRAINT issue_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_templates issue_templates_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_templates
    ADD CONSTRAINT issue_templates_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: leave_balances leave_balances_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: leave_requests leave_requests_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.leave_types(id) ON DELETE RESTRICT;


--
-- Name: leave_requests leave_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: leave_requests leave_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: leave_requests leave_requests_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: leave_types leave_types_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: magic_link_tokens magic_link_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_link_tokens
    ADD CONSTRAINT magic_link_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_workspace_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: offices offices_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offices
    ADD CONSTRAINT offices_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: okr_key_results okr_key_results_objective_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_key_results
    ADD CONSTRAINT okr_key_results_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.okr_objectives(id) ON DELETE CASCADE;


--
-- Name: okr_key_results okr_key_results_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_key_results
    ADD CONSTRAINT okr_key_results_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: okr_objectives okr_objectives_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_objectives
    ADD CONSTRAINT okr_objectives_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: okr_objectives okr_objectives_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_objectives
    ADD CONSTRAINT okr_objectives_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.okr_objectives(id);


--
-- Name: okr_objectives okr_objectives_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_objectives
    ADD CONSTRAINT okr_objectives_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: okr_sprint_links okr_sprint_links_objective_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_sprint_links
    ADD CONSTRAINT okr_sprint_links_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.okr_objectives(id) ON DELETE CASCADE;


--
-- Name: okr_sprint_links okr_sprint_links_sprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.okr_sprint_links
    ADD CONSTRAINT okr_sprint_links_sprint_id_fkey FOREIGN KEY (sprint_id) REFERENCES public.sprints(id) ON DELETE CASCADE;


--
-- Name: operations_ai_action_decisions operations_ai_action_decisions_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_action_decisions
    ADD CONSTRAINT operations_ai_action_decisions_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.operations_ai_actions(id) ON DELETE CASCADE;


--
-- Name: operations_ai_action_decisions operations_ai_action_decisions_decision_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_action_decisions
    ADD CONSTRAINT operations_ai_action_decisions_decision_by_fkey FOREIGN KEY (decision_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operations_ai_action_decisions operations_ai_action_decisions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_action_decisions
    ADD CONSTRAINT operations_ai_action_decisions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: operations_ai_actions operations_ai_actions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operations_ai_actions operations_ai_actions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operations_ai_actions operations_ai_actions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: operations_ai_actions operations_ai_actions_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operations_ai_actions operations_ai_actions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: operations_ai_actions operations_ai_actions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_ai_actions
    ADD CONSTRAINT operations_ai_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: operations_automation_rules operations_automation_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_automation_rules
    ADD CONSTRAINT operations_automation_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operations_automation_rules operations_automation_rules_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_automation_rules
    ADD CONSTRAINT operations_automation_rules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operations_automation_rules operations_automation_rules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_automation_rules
    ADD CONSTRAINT operations_automation_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_checkout_sessions payment_checkout_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checkout_sessions
    ADD CONSTRAINT payment_checkout_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payment_checkout_sessions payment_checkout_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checkout_sessions
    ADD CONSTRAINT payment_checkout_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: payment_customers payment_customers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: performance_reviews performance_reviews_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews
    ADD CONSTRAINT performance_reviews_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.review_cycles(id) ON DELETE CASCADE;


--
-- Name: performance_reviews performance_reviews_reviewee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews
    ADD CONSTRAINT performance_reviews_reviewee_id_fkey FOREIGN KEY (reviewee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: performance_reviews performance_reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews
    ADD CONSTRAINT performance_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: project_statuses project_statuses_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_statuses
    ADD CONSTRAINT project_statuses_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_workspace_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: review_cycles review_cycles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_cycles
    ADD CONSTRAINT review_cycles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: saved_filters saved_filters_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_filters
    ADD CONSTRAINT saved_filters_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: saved_filters saved_filters_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_filters
    ADD CONSTRAINT saved_filters_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: screen_activity_events screen_activity_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screen_activity_events
    ADD CONSTRAINT screen_activity_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: screen_activity_events screen_activity_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.screen_activity_events
    ADD CONSTRAINT screen_activity_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: sprints sprints_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sprints
    ADD CONSTRAINT sprints_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sprints sprints_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sprints
    ADD CONSTRAINT sprints_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: subtasks subtasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks
    ADD CONSTRAINT subtasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: subtasks subtasks_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks
    ADD CONSTRAINT subtasks_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: system_users system_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_users
    ADD CONSTRAINT system_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: system_users system_users_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_users
    ADD CONSTRAINT system_users_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: task_assignees task_assignees_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_assignees task_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_attachments task_attachments_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: task_attachments task_attachments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_attachments task_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_links task_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_links task_links_source_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_source_task_id_fkey FOREIGN KEY (source_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_links task_links_target_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_target_task_id_fkey FOREIGN KEY (target_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_status_columns task_status_columns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_status_columns
    ADD CONSTRAINT task_status_columns_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: task_status_columns task_status_columns_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_status_columns
    ADD CONSTRAINT task_status_columns_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: task_tag_assignments task_tag_assignments_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tag_assignments
    ADD CONSTRAINT task_tag_assignments_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: task_tag_assignments task_tag_assignments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tag_assignments
    ADD CONSTRAINT task_tag_assignments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_votes task_votes_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_votes
    ADD CONSTRAINT task_votes_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_votes task_votes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_votes
    ADD CONSTRAINT task_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_watchers task_watchers_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_watchers
    ADD CONSTRAINT task_watchers_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_watchers task_watchers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_watchers
    ADD CONSTRAINT task_watchers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_sprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_sprint_id_fkey FOREIGN KEY (sprint_id) REFERENCES public.sprints(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_status_column_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_status_column_id_fkey FOREIGN KEY (status_column_id) REFERENCES public.task_status_columns(id);


--
-- Name: tasks tasks_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_workspace_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: time_logs time_logs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_logs
    ADD CONSTRAINT time_logs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: time_logs time_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_logs
    ADD CONSTRAINT time_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_activation_payments user_activation_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activation_payments
    ADD CONSTRAINT user_activation_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_activation_payments user_activation_payments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_activation_payments
    ADD CONSTRAINT user_activation_payments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: user_keys user_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_keys
    ADD CONSTRAINT user_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_offices user_offices_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_offices
    ADD CONSTRAINT user_offices_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;


--
-- Name: user_offices user_offices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_offices
    ADD CONSTRAINT user_offices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_workspace_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_workspace_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE CASCADE;


--
-- Name: webhooks webhooks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: wfh_requests wfh_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wfh_requests
    ADD CONSTRAINT wfh_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: wfh_requests wfh_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wfh_requests
    ADD CONSTRAINT wfh_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: wfh_requests wfh_requests_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wfh_requests
    ADD CONSTRAINT wfh_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: wiki_page_versions wiki_page_versions_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_page_versions
    ADD CONSTRAINT wiki_page_versions_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES public.users(id);


--
-- Name: wiki_page_versions wiki_page_versions_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_page_versions
    ADD CONSTRAINT wiki_page_versions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.wiki_pages(id) ON DELETE CASCADE;


--
-- Name: wiki_pages wiki_pages_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_pages
    ADD CONSTRAINT wiki_pages_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wiki_pages wiki_pages_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_pages
    ADD CONSTRAINT wiki_pages_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.wiki_pages(id) ON DELETE SET NULL;


--
-- Name: wiki_pages wiki_pages_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_pages
    ADD CONSTRAINT wiki_pages_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.wiki_spaces(id) ON DELETE CASCADE;


--
-- Name: wiki_pages wiki_pages_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_pages
    ADD CONSTRAINT wiki_pages_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: wiki_spaces wiki_spaces_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_spaces
    ADD CONSTRAINT wiki_spaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wiki_spaces wiki_spaces_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wiki_spaces
    ADD CONSTRAINT wiki_spaces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_ai_settings workspace_ai_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_ai_settings
    ADD CONSTRAINT workspace_ai_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_digest_preferences workspace_digest_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_preferences
    ADD CONSTRAINT workspace_digest_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_digest_preferences workspace_digest_preferences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_preferences
    ADD CONSTRAINT workspace_digest_preferences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_digest_runs workspace_digest_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_runs
    ADD CONSTRAINT workspace_digest_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_digest_runs workspace_digest_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_digest_runs
    ADD CONSTRAINT workspace_digest_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_holidays workspace_holidays_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_holidays
    ADD CONSTRAINT workspace_holidays_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_holidays workspace_holidays_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_holidays
    ADD CONSTRAINT workspace_holidays_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_memory_entries workspace_memory_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memory_entries
    ADD CONSTRAINT workspace_memory_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_memory_entries workspace_memory_entries_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memory_entries
    ADD CONSTRAINT workspace_memory_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_recovery_jobs workspace_recovery_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_recovery_jobs
    ADD CONSTRAINT workspace_recovery_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_search_history workspace_search_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_search_history
    ADD CONSTRAINT workspace_search_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_search_history workspace_search_history_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_search_history
    ADD CONSTRAINT workspace_search_history_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_sso_configs workspace_sso_configs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sso_configs
    ADD CONSTRAINT workspace_sso_configs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_subscriptions workspace_subscriptions_billing_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_billing_plan_id_fkey FOREIGN KEY (billing_plan_id) REFERENCES public.billing_plans(id);


--
-- Name: workspace_subscriptions workspace_subscriptions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_users workspace_users_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_users
    ADD CONSTRAINT workspace_users_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_users workspace_users_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_users
    ADD CONSTRAINT workspace_users_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_work_schedule workspace_work_schedule_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_work_schedule
    ADD CONSTRAINT workspace_work_schedule_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict mcBahjxcUil0GvmvROADAJgxyLxgM4bBCuey9lcqtTdjyBqwnWUKitrIoRzO1f9

