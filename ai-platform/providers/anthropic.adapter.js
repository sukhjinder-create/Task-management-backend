// ai-platform/providers/anthropic.adapter.js
//
// Claude (Anthropic Messages API). Not present in the legacy llm.js — added so
// the platform can route capabilities (e.g., Meeting Intelligence) to Claude
// purely via configuration. Uses the REST API directly (no SDK) to keep the
// "no provider SDK outside adapters, secrets only in adapters" invariant.

import axios from "axios";
import { BaseAdapter, resolveApiKey, extractUsage } from "./base.adapter.js";

export class AnthropicAdapter extends BaseAdapter {
  async generate({ model, prompt, messages, options = {}, providerConfig = {}, signal }) {
    const apiKey = resolveApiKey(providerConfig, ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]);
    const base = String(providerConfig.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const resolvedModel = model || providerConfig.defaultModel || "claude-sonnet-5";

    // Split any system message; Anthropic takes `system` as a top-level field.
    const msgs = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: "user", content: String(prompt ?? "") }];
    const system = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined;
    const userAssistant = msgs
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));

    const res = await axios.post(
      `${base}/v1/messages`,
      {
        model: resolvedModel,
        max_tokens: options.maxTokens ?? 900,
        temperature: options.temperature ?? 0.4,
        ...(options.topP != null ? { top_p: options.topP } : {}),
        ...(system ? { system } : {}),
        messages: userAssistant.length ? userAssistant : [{ role: "user", content: String(prompt ?? "") }],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": providerConfig.extra?.apiVersion || "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: options.timeoutMs || providerConfig.timeoutMs || 60000,
        ...(signal ? { signal } : {}),
      }
    );

    const text = Array.isArray(res.data?.content)
      ? res.data.content.map((block) => block.text || "").join("").trim()
      : "";
    if (!text) throw new Error(`Anthropic error: ${JSON.stringify(res.data)?.slice(0, 300)}`);
    return { text, usage: extractUsage(res.data), raw: res.data };
  }
}

export default new AnthropicAdapter();
