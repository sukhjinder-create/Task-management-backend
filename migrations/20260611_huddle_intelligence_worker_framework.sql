-- Durable Huddle Intelligence worker orchestration.
-- Additive and idempotent. No AI generation or automatic memory/task creation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE huddle_intelligence_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_recovered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS huddle_intelligence_job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES huddle_intelligence_jobs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES huddle_sessions(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_intelligence_job_attempts_status_check
    CHECK (status IN ('processing', 'completed', 'failed', 'retry_scheduled', 'cancelled', 'recovered')),
  CONSTRAINT huddle_intelligence_job_attempts_number_check
    CHECK (attempt_number >= 1),
  CONSTRAINT huddle_intelligence_job_attempts_unique
    UNIQUE (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS huddle_intelligence_job_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES huddle_intelligence_jobs(id) ON DELETE CASCADE,
  depends_on_job_id UUID NOT NULL REFERENCES huddle_intelligence_jobs(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'hard',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT huddle_intelligence_job_dependencies_type_check
    CHECK (dependency_type IN ('hard', 'soft')),
  CONSTRAINT huddle_intelligence_job_dependencies_not_self_check
    CHECK (job_id <> depends_on_job_id),
  CONSTRAINT huddle_intelligence_job_dependencies_unique
    UNIQUE (job_id, depends_on_job_id)
);

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_jobs_claimable
  ON huddle_intelligence_jobs (status, scheduled_at, priority, created_at)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_jobs_lease
  ON huddle_intelligence_jobs (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_attempts_job
  ON huddle_intelligence_job_attempts (job_id, attempt_number DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_attempts_session
  ON huddle_intelligence_job_attempts (workspace_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_huddle_intelligence_dependencies_job
  ON huddle_intelligence_job_dependencies (job_id, dependency_type);

CREATE OR REPLACE FUNCTION set_huddle_intelligence_worker_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_huddle_intelligence_attempts_updated_at
  ON huddle_intelligence_job_attempts;
CREATE TRIGGER trg_huddle_intelligence_attempts_updated_at
BEFORE UPDATE ON huddle_intelligence_job_attempts
FOR EACH ROW EXECUTE FUNCTION set_huddle_intelligence_worker_updated_at();

