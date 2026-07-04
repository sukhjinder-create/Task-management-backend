// ai-platform/providers/huggingface.adapter.js
//
// HuggingFace Inference API. Request shape matches services/llm.js.

import axios from "axios";
import { BaseAdapter, resolveApiKey } from "./base.adapter.js";

export class HuggingFaceAdapter extends BaseAdapter {
  async generate({ model, prompt, messages, options = {}, providerConfig = {}, signal }) {
    const apiKey = resolveApiKey(providerConfig, ["HUGGINGFACE_API_KEY", "HF_API_KEY"]);
    const resolvedModel = model || providerConfig.defaultModel || process.env.HF_MODEL || "mistralai/Mixtral-8x7B-Instruct-v0.1";
    const base = String(providerConfig.baseUrl || "https://api-inference.huggingface.co/models").replace(/\/+$/, "");
    const finalPrompt = prompt ?? (Array.isArray(messages) ? messages.map((m) => m.content).join("\n") : "");

    const res = await axios.post(
      `${base}/${resolvedModel}`,
      {
        inputs: finalPrompt,
        parameters: {
          max_new_tokens: options.maxTokens ?? 900,
          temperature: options.temperature ?? 0.4,
          top_p: options.topP ?? 0.9,
        },
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: options.timeoutMs || 60000,
        ...(signal ? { signal } : {}),
      }
    );
    if (!res.data?.length && !res.data?.generated_text) throw new Error(`HuggingFace error: ${JSON.stringify(res.data)?.slice(0, 300)}`);
    const text = Array.isArray(res.data) ? res.data[0].generated_text : res.data.generated_text;
    return { text: String(text || "").trim(), usage: null, raw: res.data };
  }
}

export default new HuggingFaceAdapter();
