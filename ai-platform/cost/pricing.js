// ai-platform/cost/pricing.js
//
// P6 — model pricing table (USD per 1,000 tokens). Approximate, permissive code
// defaults; the DB (ai_models.input_cost_per_1k / output_cost_per_1k) may override
// later. Pure data + accessor. No network, no DB.

const PRICING = Object.freeze({
  // providerKey: { modelKey: { input, output } }   USD / 1k tokens
  openai: { "gpt-4o-mini": { input: 0.00015, output: 0.0006 }, "gpt-4o": { input: 0.0025, output: 0.01 } },
  groq: { "llama-3.3-70b-versatile": { input: 0.00059, output: 0.00079 } },
  grok: { "grok-beta": { input: 0.005, output: 0.015 } },
  openrouter: { "openai/gpt-4o-mini": { input: 0.00015, output: 0.0006 } },
  together: { "meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 0.00088, output: 0.00088 } },
  deepseek: { "deepseek-chat": { input: 0.00027, output: 0.0011 } },
  anthropic: { "claude-sonnet-5": { input: 0.003, output: 0.015 } },
  gemini: { "gemini-1.5-flash": { input: 0.000075, output: 0.0003 } },
  ollama: { "*": { input: 0, output: 0 } }, // local / self-hosted
  huggingface: { "*": { input: 0, output: 0 } },
});

/**
 * @returns {{input:number, output:number, source:string}}
 */
export function getPricing(providerKey, modelKey) {
  const p = PRICING[String(providerKey || "").toLowerCase()];
  if (!p) return { input: 0, output: 0, source: "unpriced" };
  const m = p[modelKey] || p["*"];
  if (!m) return { input: 0, output: 0, source: "unpriced" };
  return { input: m.input, output: m.output, source: `code:${providerKey}` };
}
