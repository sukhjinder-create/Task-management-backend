-- ============================================================================
--  AI PLATFORM — P5: Observability columns on ai_request_logs (Contract v2 §12)
--  Additive & idempotent. Adds trace/span/trigger/source-module so an execution
--  can be reconstructed as a tree (agents/multi-pass) and attributed to the
--  business event that caused it. The telemetry writer builds its INSERT from
--  whatever columns exist, so applying this is non-regressive and changes no
--  behavior. NOT executed by this phase.
--
--  Rollback: ALTER TABLE ai_request_logs DROP COLUMN IF EXISTS trace_id, ... ;
-- ============================================================================

ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS trace_id          TEXT;
ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS span_id           TEXT;
ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS parent_span_id    TEXT;
ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS source_module     TEXT;
ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS trigger_type      TEXT;
ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS parent_request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_req_logs_trace ON ai_request_logs (trace_id);
