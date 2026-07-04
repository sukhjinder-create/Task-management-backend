// ai-platform/providers/registry.js
//
// Maps an adapter TYPE (stored on the ai_providers row) to its adapter instance.
// Adding a brand-new provider that speaks an existing protocol (any
// OpenAI-compatible API) requires only a DB row — no code. Adding a provider
// with a new protocol requires one new adapter file registered here.

import openaiCompatible from "./openaiCompatible.adapter.js";
import ollama from "./ollama.adapter.js";
import anthropic from "./anthropic.adapter.js";
import gemini from "./gemini.adapter.js";
import huggingface from "./huggingface.adapter.js";
import bedrock from "./bedrock.adapter.js";

// adapterType -> adapter instance
const ADAPTERS = new Map([
  ["openai_compatible", openaiCompatible],
  ["ollama", ollama],
  ["anthropic", anthropic],
  ["gemini", gemini],
  ["huggingface", huggingface],
  ["bedrock", bedrock],
]);

// Convenience: default adapterType for a provider key, so env-only setups
// (no ai_providers rows yet) still resolve to the right adapter.
const PROVIDER_KEY_TO_ADAPTER = {
  openai: "openai_compatible",
  groq: "openai_compatible",
  grok: "openai_compatible",
  openrouter: "openai_compatible",
  together: "openai_compatible",
  deepseek: "openai_compatible",
  azure: "openai_compatible",
  ollama: "ollama",
  local: "ollama",
  anthropic: "anthropic",
  claude: "anthropic",
  gemini: "gemini",
  google: "gemini",
  huggingface: "huggingface",
  bedrock: "bedrock",
};

export function adapterTypeForProviderKey(providerKey) {
  return PROVIDER_KEY_TO_ADAPTER[String(providerKey || "").toLowerCase()] || null;
}

export function getAdapter(adapterType) {
  const adapter = ADAPTERS.get(String(adapterType || "").toLowerCase());
  if (!adapter) {
    const err = new Error(`No AI adapter registered for type "${adapterType}"`);
    err.code = "ADAPTER_NOT_FOUND";
    throw err;
  }
  return adapter;
}

export function listAdapterTypes() {
  return [...ADAPTERS.keys()];
}
