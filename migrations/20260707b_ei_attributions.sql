-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Phase 2: immutable attributions (§5′)
--  Additive & idempotent. Stores tiered (O/A/C) attribution structures derived
--  deterministically from ei_events. Append-only, idempotent by attribution_id.
--  NOT executed by this phase (create-only). With the attribution flag OFF,
--  nothing writes here, so applying it changes no behavior.
--
--  Rollback: DROP TABLE IF EXISTS ei_attributions;
-- ============================================================================

CREATE TABLE IF NOT EXISTS ei_attributions (
  id                  BIGSERIAL PRIMARY KEY,
  attribution_id      TEXT NOT NULL UNIQUE,            -- deterministic → replay-safe
  workspace_id        TEXT NOT NULL,
  rule_key            TEXT,
  tier                TEXT NOT NULL CHECK (tier IN ('O','A','C')),
  language            TEXT NOT NULL,                   -- 'contributed to' | 'associated with' | 'caused'
  effect_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  factor_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  association_strength NUMERIC(8,6),                   -- NULL for Tier O
  confidence_low      NUMERIC(8,6),
  confidence_high     NUMERIC(8,6),
  confidence_source   TEXT,                            -- observation | association | experiment
  supporting_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradicting_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  confounders_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  identification_json JSONB,                           -- Tier C only
  temporal_from       TIMESTAMPTZ,
  temporal_to         TIMESTAMPTZ,
  provenance_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Constitutional invariant, enforced at the DB level:
  CONSTRAINT ei_attr_caused_requires_tier_c CHECK (language <> 'caused' OR tier = 'C'),
  CONSTRAINT ei_attr_tier_c_requires_identification CHECK (tier <> 'C' OR identification_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ei_attr_ws ON ei_attributions (workspace_id, tier);
CREATE INDEX IF NOT EXISTS idx_ei_attr_rule ON ei_attributions (rule_key);
