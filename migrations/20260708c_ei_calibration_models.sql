-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Wave C: Calibration models (versioned, immutable)
--  Additive & idempotent. Append-only, idempotent by calibration_id. Never overwrites
--  — each version is a new row; the current model is the highest version. NOT executed.
--  Rollback: DROP TABLE IF EXISTS ei_calibration_models;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_calibration_models (
  id                    BIGSERIAL PRIMARY KEY,
  calibration_id        TEXT NOT NULL UNIQUE,
  workspace_id          TEXT NOT NULL,
  version               INTEGER NOT NULL,
  method                TEXT NOT NULL,
  buckets_json          JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence_views_json JSONB NOT NULL DEFAULT '{}'::jsonb,   -- raw/calibrated/observed/historical (kept separate)
  supersedes_json       JSONB,                                -- lineage pointer to prior version
  provenance_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version        INTEGER NOT NULL DEFAULT 1,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_calibration_ws ON ei_calibration_models (workspace_id, version DESC);
