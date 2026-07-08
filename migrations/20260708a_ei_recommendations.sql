-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Phase 6: immutable recommendations
--  Additive & idempotent. Append-only, idempotent by recommendation_id. Every
--  recommendation references a prediction + reasoning trace (explainability) and
--  carries its uncertainty. Structured data only (no narration). NOT executed by
--  this phase.
--  Rollback: DROP TABLE IF EXISTS ei_recommendations;
--
--  Note (Wave B): the Executive Intelligence (P7), Business Narration (P8), Graph
--  projection, and Metrics layers are COMPUTED projections of the immutable records
--  (traces/predictions/recommendations) and therefore add NO new tables.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_recommendations (
  id                    BIGSERIAL PRIMARY KEY,
  recommendation_id     TEXT NOT NULL UNIQUE,
  workspace_id          TEXT NOT NULL,
  entity_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation_type   TEXT NOT NULL,
  status                TEXT NOT NULL,               -- recommended | insufficient_basis | manual_review
  action_json           JSONB,                       -- structured action | null (never NL)
  rationale_refs_json   JSONB NOT NULL DEFAULT '{}'::jsonb, -- { predictionId, reasoningTraceId, evidenceIds[], attributionIds[] }
  alternatives_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  uncertainty_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_approval     BOOLEAN NOT NULL DEFAULT true,
  approval_scope_json   JSONB,
  manual_only           BOOLEAN NOT NULL DEFAULT false,
  assumptions_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  unknown_factors_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  explanation_json      JSONB NOT NULL DEFAULT '{}'::jsonb, -- structured self-explanation (no NL)
  provenance_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version        INTEGER NOT NULL DEFAULT 1,
  engine_version        TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_recs_ws ON ei_recommendations (workspace_id);
CREATE INDEX IF NOT EXISTS idx_ei_recs_status ON ei_recommendations (workspace_id, status);
