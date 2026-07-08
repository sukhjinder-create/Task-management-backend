-- ============================================================================
--  ENTERPRISE INTELLIGENCE V2.1 — Wave C: Organizational memory (versioned, immutable)
--  Additive & idempotent. Append-only, idempotent by memory_id. Current knowledge =
--  latest version per revision_key; older versions retained → replayable. NOT executed.
--  Rollback: DROP TABLE IF EXISTS ei_org_memory;
-- ============================================================================
CREATE TABLE IF NOT EXISTS ei_org_memory (
  id              BIGSERIAL PRIMARY KEY,
  memory_id       TEXT NOT NULL UNIQUE,
  workspace_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- validated_pattern | repeated_failure | ...
  key             TEXT NOT NULL,
  revision_key    TEXT NOT NULL,                 -- kind::key ; latest version = current
  version         INTEGER NOT NULL DEFAULT 1,
  value_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  support_json    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- sampleSize + outcomeIds
  valid_from      TIMESTAMPTZ,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ei_mem_ws ON ei_org_memory (workspace_id, kind);
CREATE INDEX IF NOT EXISTS idx_ei_mem_rev ON ei_org_memory (workspace_id, revision_key, version DESC);
