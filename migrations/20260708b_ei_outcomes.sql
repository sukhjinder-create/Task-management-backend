-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Wave C: Outcomes Ledger (immutable)
--  Additive & idempotent. Append-only, idempotent by outcome_id. NO UPDATE path —
--  corrections are new rows. NOT executed by this phase.
--  Rollback: DROP TABLE IF EXISTS ei_outcomes;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  outcome_id      TEXT NOT NULL UNIQUE,
  workspace_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- recommendation | prediction
  status          TEXT NOT NULL,                 -- accepted/executed/... | confirmed/refuted/...
  subject_id      TEXT NOT NULL,                 -- recommendationId or predictionId
  refs_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at     TIMESTAMPTZ NOT NULL,
  actor_json      JSONB,
  impact_json     JSONB,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_outcomes_ws ON ei_outcomes (workspace_id);
CREATE INDEX IF NOT EXISTS idx_ei_outcomes_subject ON ei_outcomes (workspace_id, kind, subject_id);
