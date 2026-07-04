// tests/ai-platform-cost.test.js
//
// P6 self-test: pre-execution cost estimate + post-execution record, and the
// gateway wiring that populates est/actual cost (fixing the "est=null" gate
// finding). Hermetic — pure cost functions + DI gateway (no network/DB).

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateCost, recordCost, estimateInputTokens, budgetCheck } from "../ai-platform/cost/costEngine.js";
import { getPricing } from "../ai-platform/cost/pricing.js";
import { invoke } from "../ai-platform/gateway.js";
import { createAIRequest, textPart } from "../ai-platform/contract/index.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

test("pricing + token estimation are deterministic", () => {
  assert.equal(estimateInputTokens({ prompt: "abcd".repeat(250) }), 250); // 1000 chars / 4
  const priced = getPricing("groq", "llama-3.3-70b-versatile");
  assert.ok(priced.input > 0);
  assert.equal(getPricing("ollama", "llama3.2:1b").input, 0); // local is free
  assert.equal(getPricing("nope", "x").source, "unpriced");
});

test("estimateCost (pre-exec) and recordCost (post-exec) compute USD amounts", () => {
  const est = estimateCost({ prompt: "hello world", maxTokens: 1000, providerKey: "groq", modelKey: "llama-3.3-70b-versatile" });
  assert.equal(est.amount.currency, "USD");
  assert.ok(est.amount.amount > 0);
  assert.ok(est.inputTokensEst > 0);
  assert.equal(est.outputTokensEst, 1000);

  const actual = recordCost({ usage: { inputTokens: 1000, outputTokens: 500 }, providerKey: "groq", modelKey: "llama-3.3-70b-versatile" });
  // 1000/1000*0.00059 + 500/1000*0.00079
  assert.ok(Math.abs(actual.amount - (0.00059 + 0.000395)) < 1e-9);

  // Local provider is free.
  assert.equal(estimateCost({ prompt: "x", maxTokens: 500, providerKey: "ollama", modelKey: "llama3.2:1b" }).amount.amount, 0);
});

test("budgetCheck is permissive in Epic A (never blocks)", () => {
  assert.equal(budgetCheck().allowed, true);
});

test("gateway populates est + actual cost into telemetry AND AIResponse.cost", async () => {
  const captured = [];
  const deps = {
    resolve: async () => ({
      capabilityKey: "c", providerKey: "groq", adapterType: "mock",
      providerConfig: { key: "groq", defaultModel: "llama-3.3-70b-versatile" },
      model: "llama-3.3-70b-versatile", profileKey: "balanced", profileParams: null, promptKey: null, requires: null,
    }),
    getAdapterFor: () => new MockAdapter({ fixedText: "reply" }),
    checkPolicies: async () => ({ allowed: true }),
    resolvePromptTemplate: async () => null,
    logAiRequest: async (r) => captured.push(r),
    resolveCompatibility: () => ({ ok: true, gaps: [], checked: false }),
  };
  const req = createAIRequest({ capability: "c", input: [textPart({ text: "estimate me" })], runtime: { overrides: { maxTokens: 200 } } });
  const res = await invoke(req, deps);

  assert.equal(res.cost.currency, "USD");
  assert.ok(res.cost.estimated >= 0);
  assert.ok(res.cost.actual >= 0);
  assert.equal(res.cost.owner, "PLATFORM");
  // Telemetry received a real (non-null) estimate — the gate finding is fixed.
  assert.notEqual(captured[0].estCostUsd, null);
  assert.equal(typeof captured[0].actualCostUsd, "number");
});
