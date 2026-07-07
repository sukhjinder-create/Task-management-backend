-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Phase 3: immutable evidence layer
--  Additive & idempotent. Append-only; invalidation via supersession (latest
--  revision per revision_key is current). NOT executed by this phase.
--  Rollback: DROP TABLE IF EXISTS ei_evidence;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_evidence (
  id                   BIGSERIAL PRIMARY KEY,
  evidence_id          TEXT NOT NULL UNIQUE,
  workspace_id         TEXT NOT NULL,
  revision_key         TEXT NOT NULL,              -- latest revision = current evidence
  entity_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  supporting_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradicting_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence_source    TEXT,
  temporal_from        TIMESTAMPTZ,
  temporal_to          TIMESTAMPTZ,
  provenance_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version       INTEGER NOT NULL DEFAULT 1,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_evidence_ws_rev ON ei_evidence (workspace_id, revision_key, recorded_at DESC);
