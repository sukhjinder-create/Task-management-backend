CREATE TABLE IF NOT EXISTS workspace_recovery_jobs (
  id              UUID PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','success','failed')),
  requested_by    TEXT,
  dry_run         BOOLEAN NOT NULL DEFAULT false,
  batch_size      INT NOT NULL DEFAULT 500,
  source_label    TEXT,
  rows_scanned    BIGINT NOT NULL DEFAULT 0,
  rows_written    BIGINT NOT NULL DEFAULT 0,
  table_summary   JSONB NOT NULL DEFAULT '[]'::jsonb,
  progress_pct    NUMERIC(6,2) NOT NULL DEFAULT 0,
  current_table   TEXT,
  progress_message TEXT,
  event_log       JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_recovery_jobs_workspace_created
ON workspace_recovery_jobs(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_recovery_jobs_status_created
ON workspace_recovery_jobs(status, created_at DESC);

ALTER TABLE workspace_recovery_jobs
ADD COLUMN IF NOT EXISTS progress_pct NUMERIC(6,2) NOT NULL DEFAULT 0;

ALTER TABLE workspace_recovery_jobs
ADD COLUMN IF NOT EXISTS current_table TEXT;

ALTER TABLE workspace_recovery_jobs
ADD COLUMN IF NOT EXISTS progress_message TEXT;

ALTER TABLE workspace_recovery_jobs
ADD COLUMN IF NOT EXISTS event_log JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE workspace_recovery_jobs
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
