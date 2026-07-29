// ai-platform/providers/ollama.adapter.js
//
// Local / cloud Ollama. Request body matches services/llm.js exactly so the
// default (LLM_PROVIDER=ollama) path is byte-for-byte preserved.

import axios from "axios";
import { BaseAdapter } from "./base.adapter.js";

export class OllamaAdapter extends BaseAdapter {
  async generate({ model, prompt, messages, options = {}, providerConfig = {}, signal }) {
    const baseUrl = String(providerConfig.baseUrl || process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
    const resolvedModel = model || providerConfig.defaultModel || process.env.OLLAMA_MODEL || "llama3.2:1b";
    const numGpu = options.numGpu ?? parseInt(process.env.OLLAMA_NUM_GPU ?? "0", 10);
    const finalPrompt = prompt ?? (Array.isArray(messages) ? messages.map((m) => m.content).join("\n") : "");

    try {
      const res = await axios.post(
        `${baseUrl}/api/generate`,
        {
          model: resolvedModel,
          prompt: finalPrompt,
          stream: false,
          ...(options.json ? { format: "json" } : {}),
          options: {
            num_predict: options.maxTokens ?? 900,
            temperature: options.temperature ?? 0.4,
            top_k: options.topK ?? 20,
            top_p: options.topP ?? 0.9,
            num_gpu: numGpu,
          },
        },
        { timeout: options.timeoutMs || 120000, ...(signal ? { signal } : {}) }
      );
      if (!res.data?.response) throw new Error("Empty response from Ollama");
      return {
        text: res.data.response.trim(),
        usage: {
          inputTokens: res.data.prompt_eval_count ?? null,
          outputTokens: res.data.eval_count ?? null,
        },
        raw: res.data,
      };
    } catch (err) {
      if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw new Error("LLM timeout");
      throw err;
    }
  }
}

export default new OllamaAdapter();
