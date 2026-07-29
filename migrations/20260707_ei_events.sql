-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Phase 1: immutable event log (§6/§7)
--  Additive & idempotent. Append-only, per-workspace-sequenced, idempotent event
--  substrate for attribution/graph projection. NOT executed by this phase
--  (create-only, per program guardrails). With the pipeline flag OFF, nothing
--  writes here, so applying it changes no behavior.
--
--  Rollback: DROP TABLE IF EXISTS ei_events;
-- ============================================================================

CREATE TABLE IF NOT EXISTS ei_events (
  id             BIGSERIAL PRIMARY KEY,
  event_id       TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  seq            BIGINT NOT NULL,                    -- strictly monotonic per workspace
  type           TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  occurred_at    TIMESTAMPTZ NOT NULL,               -- when it happened (temporal truth)
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- when it was appended
  actor_type     TEXT,
  actor_id       TEXT,
  entities_json  JSONB NOT NULL DEFAULT '[]'::jsonb, -- typed entity refs
  trace_json     JSONB NOT NULL DEFAULT '{}'::jsonb, -- traceId/correlationId/causationId
  origin         TEXT,
  source         TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (idempotency_key),                          -- idempotent ingestion
  UNIQUE (workspace_id, seq)                         -- per-workspace ordering
);
CREATE INDEX IF NOT EXISTS idx_ei_events_ws_seq ON ei_events (workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_ei_events_ws_occurred ON ei_events (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ei_events_type ON ei_events (type);

-- IMMUTABILITY: the application only ever INSERTs (append-only). A DB-level
-- UPDATE/DELETE guard trigger is deferred to a hardening phase to keep this
-- migration purely additive.
