// ai-platform/providers/anthropic.adapter.js
//
// Claude (Anthropic Messages API). Not present in the legacy llm.js — added so
// the platform can route capabilities (e.g., Meeting Intelligence) to Claude
// purely via configuration. Uses the REST API directly (no SDK) to keep the
// "no provider SDK outside adapters, secrets only in adapters" invariant.

import axios from "axios";
import { BaseAdapter, resolveApiKey, extractUsage } from "./base.adapter.js";
import { toAnthropicTools, toAnthropicToolChoice, parseAnthropicToolCalls } from "./toolWire.js";

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

    // Tool calling is OPT-IN: with no options.tools the request body is identical
    // to the pre-tools implementation.
    const wireTools = options.tools ? toAnthropicTools(options.tools) : [];
    const toolChoice = wireTools.length ? toAnthropicToolChoice(options.toolChoice ?? "auto") : undefined;

    const res = await axios.post(
      `${base}/v1/messages`,
      {
        model: resolvedModel,
        max_tokens: options.maxTokens ?? 900,
        temperature: options.temperature ?? 0.4,
        ...(options.topP != null ? { top_p: options.topP } : {}),
        ...(system ? { system } : {}),
        messages: userAssistant.length ? userAssistant : [{ role: "user", content: String(prompt ?? "") }],
        ...(wireTools.length ? { tools: wireTools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
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
    const toolCalls = wireTools.length ? parseAnthropicToolCalls(res.data) : [];

    // A tool_use-only turn carries no text block; that is success, not failure.
    if (!text) {
      if (!toolCalls.length) throw new Error(`Anthropic error: ${JSON.stringify(res.data)?.slice(0, 300)}`);
      return { text: "", usage: extractUsage(res.data), toolCalls, raw: res.data };
    }
    return {
      text,
      usage: extractUsage(res.data),
      ...(toolCalls.length ? { toolCalls } : {}),
      raw: res.data,
    };
  }
}

export default new AnthropicAdapter();
