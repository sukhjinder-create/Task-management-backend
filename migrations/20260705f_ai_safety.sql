-- ============================================================================
--  AI PLATFORM — P7: Safety events (Contract v2 §11)
--  Additive & idempotent. Stores detected safety findings (injection/PII/etc.)
--  in PERMISSIVE mode — the pipeline tags and records but never blocks or
--  rewrites in Epic A. The writer is best-effort and schema-tolerant, so
--  applying this changes no behavior. NOT executed by this phase.
--
--  Rollback: DROP TABLE IF EXISTS ai_safety_events;
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_safety_events (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id   TEXT,
  capability_key TEXT,
  input_verdict  TEXT,     -- allow | flag | block (block unused in Epic A)
  output_verdict TEXT,
  findings_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_safety_events_ws_ts ON ai_safety_events (workspace_id, ts DESC);

-- Supabase exposes every table over its public REST API, so RLS is what stops an
-- anon/authenticated key reading this directly, bypassing the backend and its
-- permission checks. Enabled here, in the migration that creates the table,
-- rather than in a later sweep: 20260430_enable_rls_all_tables.sql listed tables
-- by name, so every table created after it silently arrived unprotected -- 85 of
-- them by 2026-08-05. Protecting the table where it is born is what stops that
-- recurring. The backend is unaffected; it connects as the owner, and owners
-- bypass RLS unless FORCE is set (it is not).
ALTER TABLE public.ai_safety_events ENABLE ROW LEVEL SECURITY;
