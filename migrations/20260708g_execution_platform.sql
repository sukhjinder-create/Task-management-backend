-- ============================================================================
--  ENTERPRISE WORK INTELLIGENCE PLATFORM V3 — execution substrate
--  Additive & idempotent. All tables append-only; lifecycle changes are new event
--  rows (no mutable status columns). NOT executed by this phase.
--  Rollback: DROP the tables below (all inert while EXEC_ENABLED is off).
-- ============================================================================
CREATE TABLE IF NOT EXISTS exec_decisions (
  id BIGSERIAL PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  source_recommendation_id TEXT,
  entity_json JSONB, proposed_action_json JSONB, rationale_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_approval BOOLEAN NOT NULL DEFAULT true, manual_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_exec_decisions_ws ON exec_decisions (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exec_decision_events (
  id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, decision_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, actor_json JSONB, ref TEXT, occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_dec_events ON exec_decision_events (workspace_id, decision_id, occurred_at);

CREATE TABLE IF NOT EXISTS exec_approval_requests (
  id BIGSERIAL PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, decision_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL, steps_json JSONB NOT NULL DEFAULT '[]'::jsonb, on_timeout TEXT, timeout_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS exec_approval_events (
  id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  action TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, actor_json JSONB, delegate_to_json JSONB, occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_appr_events ON exec_approval_events (workspace_id, approval_id, occurred_at);

CREATE TABLE IF NOT EXISTS exec_executions (
  id BIGSERIAL PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  capability_key TEXT NOT NULL, capability_version INTEGER, status TEXT NOT NULL,
  ok BOOLEAN, executed BOOLEAN, simulated BOOLEAN, output_json JSONB, failure_reason TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exec_exec_ws ON exec_executions (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS exec_verifications (
  execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, verified BOOLEAN NOT NULL,
  mode TEXT, evidence_json JSONB, failure_reason TEXT, references_json JSONB, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exec_workflow_runs (
  id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL, workflow_version INTEGER, status TEXT NOT NULL, steps_json JSONB, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exec_wf_runs ON exec_workflow_runs (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS exec_policies (
  id BIGSERIAL PRIMARY KEY, policy_id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, workspace_id TEXT,
  key TEXT NOT NULL, when_json JSONB NOT NULL, then_json JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  lock_level TEXT NOT NULL DEFAULT 'workspace_customizable', enabled BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_policies ON exec_policies (scope, workspace_id, key, version DESC);

CREATE TABLE IF NOT EXISTS exec_automations (
  id BIGSERIAL PRIMARY KEY, automation_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  key TEXT NOT NULL, trigger_json JSONB NOT NULL, action_json JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_automations ON exec_automations (workspace_id, key, version DESC);

CREATE TABLE IF NOT EXISTS exec_action_log (
  id BIGSERIAL PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  type TEXT NOT NULL, ref_id TEXT, actor_json JSONB, payload_json JSONB, occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_action_log ON exec_action_log (workspace_id, type, occurred_at DESC);
