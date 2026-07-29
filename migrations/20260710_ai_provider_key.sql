-- ============================================================================
--  AI PLATFORM — allow a provider API key to be set from the AI Studio UI.
--  Additive & idempotent. The key is read only inside adapters (never returned by
--  any read model). Env-based keys continue to work; a DB key just takes priority.
--  Rollback: ALTER TABLE ai_providers DROP COLUMN IF EXISTS api_key;
-- ============================================================================
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS api_key TEXT;
