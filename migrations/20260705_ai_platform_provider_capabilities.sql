-- ============================================================================
--  AI PLATFORM — P2: Provider & model capability columns
--  Additive & idempotent. Lets an operator OVERRIDE the code-default capability
--  matrix (ai-platform/providers/descriptors.js) per provider/model. Until a row
--  sets these, the code defaults apply, so applying this migration changes no
--  behavior. NOT executed by this phase (create-only, per program guardrails).
--
--  Rollback: DROP the added columns (see bottom).
-- ============================================================================

ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS supports_json      BOOLEAN;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS supports_tools     BOOLEAN;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS supports_vision    BOOLEAN;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS supports_audio     BOOLEAN;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS supports_streaming BOOLEAN;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS supports_embeddings BOOLEAN;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS modalities_in      TEXT[];
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS modalities_out     TEXT[];
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS adapter_protocol   TEXT;
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS auth_style         TEXT;

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_json      BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_tools     BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_vision    BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_audio     BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_streaming BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_reasoning BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS supports_embeddings BOOLEAN;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS modalities_in      TEXT[];
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS modalities_out     TEXT[];
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS latency_class      TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_class         TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS availability       TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS alias_of           TEXT;

-- ============================================================================
--  ROLLBACK:
--    ALTER TABLE ai_providers DROP COLUMN IF EXISTS supports_json, ... ;
--    ALTER TABLE ai_models    DROP COLUMN IF EXISTS supports_json, ... ;
-- ============================================================================
