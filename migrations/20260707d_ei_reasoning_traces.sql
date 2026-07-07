-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Phase 4: immutable reasoning traces
--  Additive & idempotent. Append-only, idempotent by trace_id. Pure structured
--  data (no narration). NOT executed by this phase.
--  Rollback: DROP TABLE IF EXISTS ei_reasoning_traces;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_reasoning_traces (
  id             BIGSERIAL PRIMARY KEY,
  trace_id       TEXT NOT NULL UNIQUE,
  workspace_id   TEXT NOT NULL,
  trace_version  INTEGER NOT NULL DEFAULT 1,
  claim_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_body_json JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the full structured trace
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_traces_ws ON ei_reasoning_traces (workspace_id);
