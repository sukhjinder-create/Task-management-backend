-- Ensure backup_logs exists for superadmin backup APIs
CREATE TABLE IF NOT EXISTS backup_logs (
  id              UUID        PRIMARY KEY,
  status          TEXT        NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  triggered_by    TEXT        NOT NULL DEFAULT 'cron',
  file_name       TEXT,
  file_size_bytes BIGINT,
  storage_type    TEXT,
  storage_path    TEXT,
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backup_logs_started_at ON backup_logs(started_at DESC);
