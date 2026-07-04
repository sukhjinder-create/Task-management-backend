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

/**
 * Resolve an API key for a provider from the environment. Keys live ONLY in
 * env and are only ever read here / inside adapters — never returned to callers,
 * never logged.
 */
export function resolveApiKey(providerConfig, fallbackEnvNames = []) {
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
