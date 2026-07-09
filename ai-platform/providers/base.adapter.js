// ai-platform/providers/base.adapter.js
//
// The provider contract. Every provider (OpenAI, Claude, Groq, Gemini, Azure,
// Ollama, OpenRouter, Together, DeepSeek, Bedrock, and anything future) is
// implemented as an adapter that fulfils this interface. NOTHING outside an
// adapter is allowed to import a provider SDK or hold a provider API key.
//
// Contract:
//   async generate({ model, prompt, messages, options, providerConfig, signal })
//     -> { text: string, usage: { inputTokens, outputTokens }|null, raw: any }
//
// `options` is the resolved runtime-profile shape:
//   { maxTokens, temperature, topP, topK, json, timeoutMs, numGpu }
//
// `providerConfig` is the resolved provider row:
//   { key, adapter, baseUrl, apiKeyEnv, authStyle, defaultModel, timeoutMs, extra }

import { resolveKeyRef } from "../keys/keyRef.js";

/**
 * Resolve an API key for a provider. Keys live ONLY in a secret manager / env and
 * are only ever read here / inside adapters — never returned to callers, never
 * logged. P8: if the resolved provider carries a KeyRef (platform-managed or
 * workspace BYO), it is used first; otherwise the legacy env-name lookup applies
 * (backward compatible — no KeyRef is set until key ownership is configured).
 */
export function resolveApiKey(providerConfig, fallbackEnvNames = []) {
  // A key set from the AI Studio UI (stored on the provider row) wins — this is what
  // lets a superadmin configure providers other than the env-configured default.
  if (providerConfig?.apiKey && String(providerConfig.apiKey).trim()) return String(providerConfig.apiKey).trim();
  if (providerConfig?.keyRef) {
    try {
      const fromRef = resolveKeyRef(providerConfig.keyRef);
      if (fromRef) return fromRef;
    } catch {
      // Misconfigured/unwired KeyRef → fall back to env (permissive; never breaks).
    }
  }
  const names = [providerConfig?.apiKeyEnv, ...fallbackEnvNames].filter(Boolean);
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

/**
 * Normalize a prompt/messages pair into an OpenAI-style messages array.
 */
export function toMessages({ prompt, messages }) {
  if (Array.isArray(messages) && messages.length) return messages;
  return [{ role: "user", content: String(prompt ?? "") }];
}

/**
 * Best-effort token usage extraction from a variety of provider response shapes.
 */
export function extractUsage(data) {
  const u = data?.usage || data?.usageMetadata || null;
  if (!u) return null;
  return {
    inputTokens: u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? null,
    outputTokens: u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? null,
  };
}

export class BaseAdapter {
  /** @returns {Promise<{text: string, usage: object|null, raw: any}>} */
  async generate(_args) {
    throw new Error("BaseAdapter.generate() must be implemented by a concrete adapter");
  }
}
