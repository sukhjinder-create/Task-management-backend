-- ──────────────────────────────────────────────────────────────────────────────
-- backup_logs: tracks every automated and manual database backup
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backup_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  status          TEXT        NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  triggered_by    TEXT        NOT NULL DEFAULT 'cron',   -- 'cron' | 'manual'
  file_name       TEXT,
  file_size_bytes BIGINT,
  storage_type    TEXT,       -- 'local' | 's3'
  storage_path    TEXT,       -- local path or S3 key
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backup_logs_started_at ON backup_logs(started_at DESC);
