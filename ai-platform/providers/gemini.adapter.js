// ai-platform/providers/gemini.adapter.js
//
// Google Gemini (Generative Language API, REST). No SDK; key stays in-adapter.

import axios from "axios";
import { BaseAdapter, resolveApiKey } from "./base.adapter.js";

export class GeminiAdapter extends BaseAdapter {
  async generate({ model, prompt, messages, options = {}, providerConfig = {}, signal }) {
    const apiKey = resolveApiKey(providerConfig, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    const base = String(providerConfig.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    const resolvedModel = model || providerConfig.defaultModel || "gemini-1.5-flash";

    const msgs = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: String(prompt ?? "") }];
    const systemText = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = msgs
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content ?? "") }] }));

    const url = `${base}/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await axios.post(
      url,
      {
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents: contents.length ? contents : [{ role: "user", parts: [{ text: String(prompt ?? "") }] }],
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 900,
          temperature: options.temperature ?? 0.4,
          ...(options.topP != null ? { topP: options.topP } : {}),
          ...(options.topK != null ? { topK: options.topK } : {}),
          ...(options.json ? { responseMimeType: "application/json" } : {}),
        },
      },
      { headers: { "Content-Type": "application/json" }, timeout: options.timeoutMs || 60000, ...(signal ? { signal } : {}) }
    );

    const text = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) throw new Error(`Gemini error: ${JSON.stringify(res.data)?.slice(0, 300)}`);
    const u = res.data?.usageMetadata;
    return {
      text,
      usage: u ? { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null } : null,
      raw: res.data,
    };
  }
}

export default new GeminiAdapter();
