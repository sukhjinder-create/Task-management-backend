// ai-platform/providers/openaiCompatible.adapter.js
//
// One adapter covers every OpenAI-Chat-Completions-compatible provider:
//   openai, groq, grok (x.ai), openrouter, together, deepseek, azure-openai.
// They differ only by base URL, auth header style, and default model — all of
// which are data on the provider row, not code. Adding another compatible
// provider therefore requires ZERO code (just a provider registry row).
//
// Request/response shapes match services/llm.js exactly for openai/groq/grok so
// behavior is preserved when the platform is enabled.

import axios from "axios";
import { BaseAdapter, resolveApiKey, toMessages, extractUsage } from "./base.adapter.js";

const DEFAULTS = {
  openai:     { baseUrl: "https://api.openai.com/v1",            keys: ["OPENAI_API_KEY"],     model: "gpt-4o-mini",                 timeout: 30000 },
  groq:       { baseUrl: "https://api.groq.com/openai/v1",       keys: ["GROQ_API_KEY"],       model: "llama-3.3-70b-versatile",     timeout: 30000 },
  grok:       { baseUrl: "https://api.x.ai/v1",                  keys: ["GROK_API_KEY"],       model: "grok-beta",                   timeout: 30000 },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1",         keys: ["OPENROUTER_API_KEY"], model: "openai/gpt-4o-mini",          timeout: 30000 },
  together:   { baseUrl: "https://api.together.xyz/v1",          keys: ["TOGETHER_API_KEY"],   model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", timeout: 30000 },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1",          keys: ["DEEPSEEK_API_KEY"],   model: "deepseek-chat",               timeout: 30000 },
  azure:      { baseUrl: null,                                    keys: ["AZURE_OPENAI_API_KEY"], model: null,                        timeout: 30000 },
};

export class OpenAICompatibleAdapter extends BaseAdapter {
  async generate({ model, prompt, messages, options = {}, providerConfig = {}, signal }) {
    const key = providerConfig.key || "openai";
    const d = DEFAULTS[key] || DEFAULTS.openai;
    const apiKey = resolveApiKey(providerConfig, d.keys);
    const resolvedModel = model || providerConfig.defaultModel || d.model;
    const timeout = options.timeoutMs || providerConfig.timeoutMs || d.timeout;
    const isAzure = key === "azure";

    let url;
    const headers = { "Content-Type": "application/json" };
    if (isAzure) {
      // Azure: {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=...
      const base = String(providerConfig.baseUrl || "").replace(/\/+$/, "");
      const apiVersion = providerConfig.extra?.apiVersion || process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
      url = `${base}/openai/deployments/${encodeURIComponent(resolvedModel)}/chat/completions?api-version=${apiVersion}`;
      headers["api-key"] = apiKey;
    } else {
      const base = String(providerConfig.baseUrl || d.baseUrl).replace(/\/+$/, "");
      url = `${base}/chat/completions`;
      headers.Authorization = `Bearer ${apiKey}`;
      if (key === "openrouter") {
        headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER || "https://asystence.com";
        headers["X-Title"] = "Asystence";
      }
    }

    const body = {
      ...(isAzure ? {} : { model: resolvedModel }),
      messages: toMessages({ prompt, messages }),
      max_tokens: options.maxTokens ?? 900,
      temperature: options.temperature ?? 0.4,
      ...(options.topP != null ? { top_p: options.topP } : {}),
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    };

    const res = await axios.post(url, body, { headers, timeout, ...(signal ? { signal } : {}) });
    const text = res.data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error(`${key} error: ${JSON.stringify(res.data)?.slice(0, 300)}`);
    return { text: text.trim(), usage: extractUsage(res.data), raw: res.data };
  }
}

export default new OpenAICompatibleAdapter();
