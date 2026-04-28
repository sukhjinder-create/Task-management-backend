// services/llm.js
// Unified LLM client — single source of truth for all AI text generation.
//
// Configuration (via .env):
//   LLM_PROVIDER   = ollama (default) | openai | grok | groq | huggingface
//   OLLAMA_MODEL   = model name        (default: llama3)
//   OLLAMA_NUM_GPU = GPU layers        (default: 0  → CPU only / cloud-routed)
//   OPENAI_API_KEY, GROK_API_KEY, GROQ_API_KEY, HUGGINGFACE_API_KEY as needed

import axios from "axios";

const PROVIDER     = process.env.LLM_PROVIDER  || "ollama";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL  || "llama3.2:1b";
const OLLAMA_URL   = process.env.OLLAMA_URL    || "http://localhost:11434";
const OLLAMA_NUM_GPU = parseInt(process.env.OLLAMA_NUM_GPU ?? "0");

/**
 * Generate text from the configured LLM provider.
 *
 * @param {object} opts
 * @param {string}      opts.prompt
 * @param {number}      [opts.maxTokens=900]
 * @param {boolean}     [opts.json=false]   — hint to provider to return JSON
 * @param {AbortSignal} [opts.signal]       — optional abort signal (Ollama only)
 * @returns {Promise<string>}
 */
export async function generateText({ prompt, maxTokens = 900, json = false, signal } = {}) {
  switch (PROVIDER) {
    case "ollama":
    case "local":       return _ollama(prompt, maxTokens, signal);
    case "openai":      return _openai(prompt, maxTokens, json);
    case "grok":        return _grok(prompt, maxTokens);
    case "groq":        return _groq(prompt, maxTokens);
    case "huggingface": return _huggingface(prompt, maxTokens);
    default:
      throw new Error(`Unsupported LLM_PROVIDER: "${PROVIDER}". Valid values: ollama, openai, grok, groq, huggingface`);
  }
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function _ollama(prompt, maxTokens, signal) {
  try {
    const res = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature: 0.4,
          top_k: 20,
          top_p: 0.9,
          num_gpu: OLLAMA_NUM_GPU,
        },
      },
      {
        timeout: 120000,
        ...(signal ? { signal } : {}),
      }
    );

    if (!res.data?.response) throw new Error("Empty response from Ollama");
    return res.data.response.trim();
  } catch (err) {
    if (err.name === "AbortError" || err.code === "ERR_CANCELED") throw new Error("LLM timeout");
    throw err;
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function _openai(prompt, maxTokens, json) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.4,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

// ─── Grok ─────────────────────────────────────────────────────────────────────

async function _grok(prompt, maxTokens) {
  const res = await axios.post(
    "https://api.x.ai/v1/chat/completions",
    {
      model: "grok-beta",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROK_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  if (!res.data?.choices?.[0]) throw new Error(`Grok error: ${JSON.stringify(res.data)}`);
  return res.data.choices[0].message.content.trim();
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function _groq(prompt, maxTokens) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  if (!res.data?.choices?.[0]) throw new Error(`Groq error: ${JSON.stringify(res.data)}`);
  return res.data.choices[0].message.content.trim();
}

// ─── HuggingFace ──────────────────────────────────────────────────────────────

async function _huggingface(prompt, maxTokens) {
  const model = process.env.HF_MODEL || "mistralai/Mixtral-8x7B-Instruct-v0.1";
  const res = await axios.post(
    `https://api-inference.huggingface.co/models/${model}`,
    {
      inputs: prompt,
      parameters: { max_new_tokens: maxTokens, temperature: 0.4, top_p: 0.9 },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );
  if (!res.data?.length) throw new Error(`HuggingFace error: ${JSON.stringify(res.data)}`);
  return (Array.isArray(res.data) ? res.data[0].generated_text : res.data.generated_text).trim();
}
