// ai-platform/cost/costEngine.js
//
// P6 — Cost engine (Contract v2 §17). Pre-execution ESTIMATE + post-execution
// RECORD. PERMISSIVE: budgetCheck never blocks in Epic A (hard enforcement is E1);
// this phase exists to populate cost so budgets *can* fire later and to fix the
// "est_cost always null" gate finding. Pure functions. No network, no DB.

import { getPricing } from "./pricing.js";

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Rough, deterministic token estimate (chars/4) for a prompt/messages input. */
export function estimateInputTokens({ prompt, messages } = {}) {
  let chars = 0;
  if (typeof prompt === "string") chars += prompt.length;
  if (Array.isArray(messages)) for (const m of messages) chars += String(m?.content ?? "").length;
  return Math.ceil(chars / 4);
}

/**
 * Pre-execution cost estimate. Output tokens are bounded by maxTokens (worst case).
 * @returns {{amount:{amount:number, currency:string}, pricingSource:string, inputTokensEst:number, outputTokensEst:number}}
 */
export function estimateCost({ prompt, messages, maxTokens = 900, providerKey, modelKey } = {}) {
  const pricing = getPricing(providerKey, modelKey);
  const inputTokensEst = estimateInputTokens({ prompt, messages });
  const outputTokensEst = Number(maxTokens) || 0;
  const amount = round6((inputTokensEst / 1000) * pricing.input + (outputTokensEst / 1000) * pricing.output);
  return {
    amount: { amount, currency: "USD" },
    pricingSource: pricing.source,
    inputTokensEst,
    outputTokensEst,
  };
}

/**
 * Post-execution actual cost from provider usage.
 * @returns {{amount:number, currency:string, pricingSource:string}}
 */
export function recordCost({ usage, providerKey, modelKey } = {}) {
  const pricing = getPricing(providerKey, modelKey);
  const inTok = Number(usage?.inputTokens) || 0;
  const outTok = Number(usage?.outputTokens) || 0;
  const amount = round6((inTok / 1000) * pricing.input + (outTok / 1000) * pricing.output);
  return { amount, currency: "USD", pricingSource: pricing.source };
}

/** PERMISSIVE in Epic A — always allowed. Hard enforcement lands in E1. */
export function budgetCheck() {
  return { allowed: true, reason: "permissive" };
}
