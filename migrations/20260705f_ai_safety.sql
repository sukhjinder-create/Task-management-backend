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
