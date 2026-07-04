// tests/ai-platform-provider-port.test.js
//
// P2 self-test: provider/model capability discovery + negotiation + the composed
// ProviderPort. Hermetic — pure functions only; the ONE invoke() test injects a
// MockAdapter so NO network (and no production DB) is ever touched.

import { test } from "node:test";
import assert from "node:assert/strict";

import { providerDescriptor, modelDescriptor, listProviderKeys } from "../ai-platform/providers/descriptors.js";
import { negotiate, firstCompatible } from "../ai-platform/providers/negotiation.js";
import { getProviderPort } from "../ai-platform/providers/providerPort.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

test("provider descriptors expose a capability matrix", () => {
  const groq = providerDescriptor("groq");
  assert.equal(groq.supports.json, true);
  assert.equal(groq.supports.vision, false);
  assert.deepEqual(groq.supports.modalitiesOut, ["text"]);

  const ollama = providerDescriptor("ollama");
  assert.equal(ollama.supports.tools, false);
  assert.equal(ollama.supports.vision, false);

  assert.equal(providerDescriptor("does-not-exist"), null);
  assert.ok(listProviderKeys().includes("anthropic"));
});

test("model descriptors carry context window + modalities", () => {
  const claude = modelDescriptor("anthropic");
  assert.equal(claude.contextWindowTokens, 200000);
  assert.equal(claude.supports.vision, true);
  assert.ok(claude.modalitiesIn.includes("image"));

  const gem = modelDescriptor("gemini");
  assert.ok(gem.modalitiesIn.includes("audio"));
});

test("negotiation PROVES capability requirements or returns exact gaps", () => {
  assert.equal(negotiate("groq", null, { json: true }).ok, true);

  const visionGap = negotiate("ollama", null, { vision: true });
  assert.equal(visionGap.ok, false);
  assert.ok(visionGap.gaps.includes("vision"));

  const ctxGap = negotiate("groq", null, { minContextTokens: 500000 });
  assert.equal(ctxGap.ok, false);
  assert.ok(ctxGap.gaps.includes("context_window"));

  // Unavailable provider (adapter not implemented) fails loudly, never silently.
  const bedrock = negotiate("bedrock", null, {});
  assert.equal(bedrock.ok, false);
  assert.ok(bedrock.gaps.includes("provider_unavailable"));

  assert.equal(negotiate("nope", null, {}).ok, false);
});

test("firstCompatible picks the first satisfying candidate (failover basis)", () => {
  const pick = firstCompatible(
    [{ provider: "ollama" }, { provider: "anthropic" }],
    { vision: true }
  );
  assert.deepEqual(pick, { provider: "anthropic", model: "claude-sonnet-5" });
  assert.equal(firstCompatible([{ provider: "ollama" }], { vision: true }), null);
});

test("ProviderPort composes descriptor + negotiation + adapter.invoke (mock-injected, no network)", async () => {
  const mock = new MockAdapter({ fixedText: "port-ok" });
  const port = getProviderPort("groq", { adapter: mock });

  assert.equal(port.describe().displayName, "Groq");
  assert.equal(port.negotiate({ json: true }).ok, true);

  const res = await port.invoke({ prompt: "hi", options: {} });
  assert.equal(res.text, "port-ok"); // adapter behavior unchanged, just composed

  const cost = port.estimateCost({ prompt: "hi" });
  assert.equal(cost.amount.currency, "USD");
  assert.equal(cost.pricingSource, "unpriced"); // permissive in P2

  const health = await port.health();
  assert.ok(["available", "unknown", "limited", "unavailable"].includes(health.availability));
});
