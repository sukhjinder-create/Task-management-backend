-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Wave C: Experiments + assignments (immutable)
--  Additive & idempotent. Append-only. Fully-declared arms/allocations (auditable);
--  deterministic, replayable assignments. NOT executed by this phase.
--  Rollback: DROP TABLE IF EXISTS ei_experiment_assignments; DROP TABLE IF EXISTS ei_experiments;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_experiments (
  id              BIGSERIAL PRIMARY KEY,
  experiment_id   TEXT NOT NULL UNIQUE,
  workspace_id    TEXT NOT NULL,
  key             TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  design          TEXT NOT NULL,                 -- ab | holdout | randomized | manual | policy
  arms_json       JSONB NOT NULL DEFAULT '[]'::jsonb,
  hypothesis_json JSONB,
  references_json JSONB NOT NULL DEFAULT '{}'::jsonb,   -- recommendations/predictions/outcomes
  status          TEXT NOT NULL DEFAULT 'defined',
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_exp_ws ON ei_experiments (workspace_id);

CREATE TABLE IF NOT EXISTS ei_experiment_assignments (
  id            BIGSERIAL PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE,
  experiment_id TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  arm           TEXT,
  bucket        DOUBLE PRECISION,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_exp_assign ON ei_experiment_assignments (experiment_id, subject_id);
