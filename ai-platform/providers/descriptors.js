// ai-platform/providers/descriptors.js
//
// P2 — Provider & model capability discovery (Contract v2 §5/§6).
// STATIC, declared capability data used by negotiation (§P2) so the platform can
// PROVE a provider/model can satisfy a capability's `requires` (gate Critical #2).
// Pure data + pure accessors. No network, no DB, no adapter behavior change.
// The DB (ai_providers/ai_models) may override these later; this is the code default.

const T = true;
const F = false;

/**
 * providerKey → { displayName, adapterProtocol, authStyle, supports, defaultModel, models }
 * `models` maps modelKey → partial ModelDescriptor overrides.
 */
const PROVIDERS = Object.freeze({
  openai: {
    displayName: "OpenAI", adapterProtocol: "openai_chat", authStyle: "bearer",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: T, audio: F, batch: T },
    defaultModel: "gpt-4o-mini",
    models: { "gpt-4o-mini": { contextWindowTokens: 128000, vision: T }, "gpt-4o": { contextWindowTokens: 128000, vision: T } },
  },
  groq: {
    displayName: "Groq", adapterProtocol: "openai_chat", authStyle: "bearer",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: F, audio: F, batch: F },
    defaultModel: "llama-3.3-70b-versatile",
    models: { "llama-3.3-70b-versatile": { contextWindowTokens: 128000 } },
  },
  grok: {
    displayName: "xAI Grok", adapterProtocol: "openai_chat", authStyle: "bearer",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: F, audio: F, batch: F },
    defaultModel: "grok-beta",
    models: { "grok-beta": { contextWindowTokens: 131072 } },
  },
  openrouter: {
    displayName: "OpenRouter", adapterProtocol: "openai_chat", authStyle: "bearer",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: T, audio: F, batch: F },
    defaultModel: "openai/gpt-4o-mini",
    models: { "openai/gpt-4o-mini": { contextWindowTokens: 128000, vision: T } },
  },
  together: {
    displayName: "Together AI", adapterProtocol: "openai_chat", authStyle: "bearer",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: F, audio: F, batch: F },
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: { "meta-llama/Llama-3.3-70B-Instruct-Turbo": { contextWindowTokens: 128000 } },
  },
  deepseek: {
    displayName: "DeepSeek", adapterProtocol: "openai_chat", authStyle: "bearer",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: T, vision: F, audio: F, batch: F },
    defaultModel: "deepseek-chat",
    models: { "deepseek-chat": { contextWindowTokens: 64000 } },
  },
  azure: {
    displayName: "Azure OpenAI", adapterProtocol: "openai_chat", authStyle: "api_key_header",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: T, audio: F, batch: T },
    defaultModel: null,
    models: {},
  },
  anthropic: {
    displayName: "Anthropic Claude", adapterProtocol: "anthropic_messages", authStyle: "api_key_header",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: T, vision: T, audio: F, batch: T },
    defaultModel: "claude-sonnet-5",
    models: { "claude-sonnet-5": { contextWindowTokens: 200000, vision: T, reasoning: T } },
  },
  gemini: {
    displayName: "Google Gemini", adapterProtocol: "gemini", authStyle: "api_key_header",
    supports: { json: T, tools: T, streaming: T, embeddings: F, reasoning: F, vision: T, audio: T, batch: F },
    defaultModel: "gemini-1.5-flash",
    models: { "gemini-1.5-flash": { contextWindowTokens: 1000000, vision: T, audio: T } },
  },
  ollama: {
    displayName: "Ollama", adapterProtocol: "ollama_generate", authStyle: "none",
    supports: { json: T, tools: F, streaming: T, embeddings: F, reasoning: F, vision: F, audio: F, batch: F },
    defaultModel: "llama3.2:1b",
    models: { "llama3.2:1b": { contextWindowTokens: 8192 } },
  },
  huggingface: {
    displayName: "HuggingFace", adapterProtocol: "hf_inference", authStyle: "bearer",
    supports: { json: F, tools: F, streaming: F, embeddings: F, reasoning: F, vision: F, audio: F, batch: F },
    defaultModel: "mistralai/Mixtral-8x7B-Instruct-v0.1",
    models: { "mistralai/Mixtral-8x7B-Instruct-v0.1": { contextWindowTokens: 32768 } },
  },
  bedrock: {
    displayName: "AWS Bedrock", adapterProtocol: "bedrock_invoke", authStyle: "sigv4",
    supports: { json: F, tools: F, streaming: F, embeddings: F, reasoning: F, vision: F, audio: F, batch: F },
    defaultModel: null,
    models: {},
    availability: "unavailable", // adapter not yet implemented (Phase 2)
  },
});

function modalitiesFor(supports) {
  const inMods = ["text"];
  if (supports.vision) inMods.push("image");
  if (supports.audio) inMods.push("audio");
  return { modalitiesIn: inMods, modalitiesOut: ["text"] };
}

/** @returns {import("../contract/provider.js").ProviderDescriptor|null} */
export function providerDescriptor(providerKey) {
  const p = PROVIDERS[String(providerKey || "").toLowerCase()];
  if (!p) return null;
  const mods = modalitiesFor(p.supports);
  return Object.freeze({
    displayName: p.displayName,
    adapterProtocol: p.adapterProtocol,
    authStyle: p.authStyle,
    availability: p.availability || "available",
    supports: Object.freeze({ modalitiesIn: mods.modalitiesIn, modalitiesOut: mods.modalitiesOut, ...p.supports }),
  });
}

/** @returns {import("../contract/model.js").ModelDescriptor|null} */
export function modelDescriptor(providerKey, modelKey = null) {
  const p = PROVIDERS[String(providerKey || "").toLowerCase()];
  if (!p) return null;
  const key = modelKey || p.defaultModel;
  if (!key) return null;
  const override = p.models[key] || {};
  const supports = {
    json: override.json ?? p.supports.json,
    tools: override.tools ?? p.supports.tools,
    streaming: override.streaming ?? p.supports.streaming,
    reasoning: override.reasoning ?? p.supports.reasoning,
    vision: override.vision ?? p.supports.vision,
    audio: override.audio ?? p.supports.audio,
    embeddings: override.embeddings ?? p.supports.embeddings,
  };
  const mods = modalitiesFor(supports);
  return Object.freeze({
    providerKey: String(providerKey).toLowerCase(),
    key,
    displayName: key,
    contextWindowTokens: override.contextWindowTokens ?? 8192,
    modalitiesIn: mods.modalitiesIn,
    modalitiesOut: mods.modalitiesOut,
    supports: Object.freeze(supports),
    latencyClass: override.latencyClass ?? "normal",
    costClass: override.costClass ?? "low",
    lifecycle: override.lifecycle ?? "ga",
    availability: override.availability ?? p.availability ?? "available",
  });
}

export function listProviderKeys() {
  return Object.keys(PROVIDERS);
}
