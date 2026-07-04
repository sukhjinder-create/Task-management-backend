// run-ai-platform-migration.js
//
// Applies the AI Platform foundation schema and seeds:
//   • the capability registry (from code) into ai_capabilities
//   • a default provider set into ai_providers (env-driven, no secrets stored)
// Idempotent — safe to run repeatedly. Run BEFORE enabling AI_PLATFORM_ENABLED,
// though the app also degrades safely if the flag is on before this runs.

import fs from "fs";
import pool from "./db.js";
import { listCapabilities } from "./ai-platform/capabilities/registry.js";

const DEFAULT_PROVIDERS = [
  { key: "openai",      name: "OpenAI",           adapter: "openai_compatible", base_url: "https://api.openai.com/v1",      api_key_env: "OPENAI_API_KEY",      default_model: "gpt-4o-mini" },
  { key: "groq",        name: "Groq",             adapter: "openai_compatible", base_url: "https://api.groq.com/openai/v1", api_key_env: "GROQ_API_KEY",        default_model: "llama-3.3-70b-versatile" },
  { key: "grok",        name: "xAI Grok",         adapter: "openai_compatible", base_url: "https://api.x.ai/v1",            api_key_env: "GROK_API_KEY",        default_model: "grok-beta" },
  { key: "openrouter",  name: "OpenRouter",       adapter: "openai_compatible", base_url: "https://openrouter.ai/api/v1",   api_key_env: "OPENROUTER_API_KEY",  default_model: "openai/gpt-4o-mini" },
  { key: "together",    name: "Together AI",      adapter: "openai_compatible", base_url: "https://api.together.xyz/v1",     api_key_env: "TOGETHER_API_KEY",    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { key: "deepseek",    name: "DeepSeek",         adapter: "openai_compatible", base_url: "https://api.deepseek.com/v1",     api_key_env: "DEEPSEEK_API_KEY",    default_model: "deepseek-chat" },
  { key: "azure",       name: "Azure OpenAI",     adapter: "openai_compatible", base_url: null,                             api_key_env: "AZURE_OPENAI_API_KEY", default_model: null },
  { key: "anthropic",   name: "Anthropic Claude", adapter: "anthropic",         base_url: "https://api.anthropic.com",       api_key_env: "ANTHROPIC_API_KEY",   default_model: "claude-sonnet-5" },
  { key: "gemini",      name: "Google Gemini",    adapter: "gemini",            base_url: "https://generativelanguage.googleapis.com", api_key_env: "GEMINI_API_KEY", default_model: "gemini-1.5-flash" },
  { key: "ollama",      name: "Ollama",           adapter: "ollama",            base_url: process.env.OLLAMA_URL || "http://localhost:11434", api_key_env: null, default_model: process.env.OLLAMA_MODEL || "llama3.2:1b" },
  { key: "huggingface", name: "HuggingFace",      adapter: "huggingface",       base_url: "https://api-inference.huggingface.co/models", api_key_env: "HUGGINGFACE_API_KEY", default_model: "mistralai/Mixtral-8x7B-Instruct-v0.1" },
  { key: "bedrock",     name: "AWS Bedrock",      adapter: "bedrock",           base_url: null,                             api_key_env: null,                  default_model: null },
];

async function run() {
  try {
    const sql = fs.readFileSync("./migrations/20260704_ai_platform_foundation.sql", "utf8");
    await pool.query(sql);
    console.log("✅ AI Platform schema applied");

    // Seed providers (idempotent)
    for (const p of DEFAULT_PROVIDERS) {
      await pool.query(
        `INSERT INTO ai_providers (key, display_name, adapter, base_url, api_key_env, default_model)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key) DO NOTHING`,
        [p.key, p.name, p.adapter, p.base_url, p.api_key_env, p.default_model]
      );
    }
    console.log(`✅ Seeded ${DEFAULT_PROVIDERS.length} providers`);

    // Seed capabilities from the code registry (idempotent). Defaults stay NULL
    // so every capability inherits the platform/env default until configured.
    const caps = listCapabilities();
    for (const c of caps) {
      await pool.query(
        `INSERT INTO ai_capabilities (key, name, description, category, owner, default_prompt_key, default_profile_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (key) DO NOTHING`,
        [c.key, c.name, c.description, c.category, c.owner, c.defaultPromptKey, c.defaultProfile]
      );
    }
    console.log(`✅ Seeded ${caps.length} capabilities`);

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name LIKE 'ai_%' ORDER BY table_name`
    );
    console.log("AI Platform tables:", rows.map((r) => r.table_name).join(", "));
  } catch (err) {
    console.error("❌ AI Platform migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
