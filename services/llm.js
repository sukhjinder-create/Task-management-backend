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
const TRANSIENT_RETRY_ATTEMPTS = Math.min(
  Math.max(parseInt(process.env.LLM_TRANSIENT_RETRY_ATTEMPTS ?? "2", 10) || 0, 0),
  4
);
const TRANSIENT_RETRY_BASE_MS = Math.min(
  Math.max(parseInt(process.env.LLM_TRANSIENT_RETRY_BASE_MS ?? "1000", 10) || 1000, 250),
  10000
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(error) {
  const raw = error?.response?.headers?.["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function isTransientLlmError(error) {
  const status = Number(error?.response?.status || error?.status);
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  return [
    "ECONNABORTED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ERR_NETWORK",
  ].includes(error?.code);
}

async function generateTextOnce({
  prompt,
  messages,
  maxTokens,
  json,
  temperature,
  signal,
}) {
  switch (PROVIDER) {
    case "ollama":
    case "local":       return _ollama(prompt, maxTokens, json, temperature, signal);
    case "openai":      return _openai(prompt, maxTokens, json, temperature, messages);
    case "grok":        return _grok(prompt, maxTokens, json, temperature, messages);
    case "groq":        return _groq(prompt, maxTokens, json, temperature, messages);
    case "huggingface": return _huggingface(prompt, maxTokens, temperature);
    default:
      throw new Error(`Unsupported LLM_PROVIDER: "${PROVIDER}". Valid values: ollama, openai, grok, groq, huggingface`);
  }
}

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
export async function generateText({
  prompt,
  messages,
  maxTokens = 900,
  json = false,
  temperature = 0.4,
  signal,
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await generateTextOnce({
        prompt,
        messages,
        maxTokens,
        json,
        temperature,
        signal,
      });
    } catch (error) {
      const retryable =
        error?.name !== "AbortError" &&
        error?.code !== "ERR_CANCELED" &&
        isTransientLlmError(error);
      error.retryable = retryable;
      if (!retryable || attempt >= TRANSIENT_RETRY_ATTEMPTS) throw error;

      const retryAfterMs = retryAfterMilliseconds(error);
      const exponentialMs = TRANSIENT_RETRY_BASE_MS * (2 ** attempt);
      const delayMs = Math.min(
        Math.max(retryAfterMs ?? exponentialMs, TRANSIENT_RETRY_BASE_MS),
        15000
      );
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

export function getLlmRuntimeDiagnostics() {
  const model = {
    ollama: OLLAMA_MODEL,
    local: OLLAMA_MODEL,
    openai: process.env.OPENAI_MODEL || "gpt-4o-mini",
    grok: process.env.GROK_MODEL || "grok-beta",
    groq: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    huggingface: process.env.HF_MODEL || "mistralai/Mixtral-8x7B-Instruct-v0.1",
  }[PROVIDER] || null;
  const configured = {
    ollama: Boolean(OLLAMA_URL),
    local: Boolean(OLLAMA_URL),
    openai: Boolean(process.env.OPENAI_API_KEY),
    grok: Boolean(process.env.GROK_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    huggingface: Boolean(process.env.HUGGINGFACE_API_KEY),
  }[PROVIDER] || false;
  return { provider: PROVIDER, model, configured };
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function _ollama(prompt, maxTokens, json, temperature, signal) {
  try {
    const res = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        ...(json ? { format: "json" } : {}),
        options: {
          num_predict: maxTokens,
          temperature,
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

async function _openai(prompt, maxTokens, json, temperature, messages) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: messages || [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
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

async function _grok(prompt, maxTokens, json, temperature, messages) {
  const res = await axios.post(
    "https://api.x.ai/v1/chat/completions",
    {
      model: process.env.GROK_MODEL || "grok-beta",
      messages: messages || [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
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

async function _groq(prompt, maxTokens, json, temperature, messages) {
  const msgs = messages || [{ role: "user", content: prompt }];
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: msgs,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
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

async function _huggingface(prompt, maxTokens, temperature) {
  const model = process.env.HF_MODEL || "mistralai/Mixtral-8x7B-Instruct-v0.1";
  const res = await axios.post(
    `https://api-inference.huggingface.co/models/${model}`,
    {
      inputs: prompt,
      parameters: { max_new_tokens: maxTokens, temperature, top_p: 0.9 },
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
