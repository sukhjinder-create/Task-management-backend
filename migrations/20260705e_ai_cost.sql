-- ============================================================================
--  AI PLATFORM — P6: Cost columns + model pricing seed (Contract v2 §17)
--  Additive & idempotent. Adds actual_cost_usd to the request log and seeds
--  representative per-1k pricing onto ai_models (UPDATE-only; affects existing
--  rows). Cost is computed by the code cost engine in permissive mode, so this
--  migration changes no behavior. NOT executed by this phase.
--
--  Rollback: ALTER TABLE ai_request_logs DROP COLUMN IF EXISTS actual_cost_usd;
-- ============================================================================

ALTER TABLE ai_request_logs ADD COLUMN IF NOT EXISTS actual_cost_usd NUMERIC(12,6);

-- Seed pricing (USD / 1k tokens) for known default models. UPDATE-only; no-op if
-- the row is absent. Idempotent.
UPDATE ai_models SET input_cost_per_1k = 0.00015, output_cost_per_1k = 0.0006  WHERE provider_key='openai'    AND model_key='gpt-4o-mini';
UPDATE ai_models SET input_cost_per_1k = 0.00059, output_cost_per_1k = 0.00079 WHERE provider_key='groq'      AND model_key='llama-3.3-70b-versatile';
UPDATE ai_models SET input_cost_per_1k = 0.003,   output_cost_per_1k = 0.015   WHERE provider_key='anthropic' AND model_key='claude-sonnet-5';
UPDATE ai_models SET input_cost_per_1k = 0.000075,output_cost_per_1k = 0.0003  WHERE provider_key='gemini'    AND model_key='gemini-1.5-flash';
UPDATE ai_models SET input_cost_per_1k = 0,       output_cost_per_1k = 0       WHERE provider_key='ollama';
