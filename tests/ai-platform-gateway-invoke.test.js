// tests/ai-platform-gateway-invoke.test.js
//
// P3 self-test: the gateway invoke(AIRequest)->AIResponse core and the
// backward-compatible shims (runCapability / gatewayGenerateText). Hermetic —
// ALL dependencies (resolver, adapter, policy, prompt, telemetry, negotiation)
// are injected, so no real resolver, no network, and NO production database is
// ever touched. Telemetry is also disabled defensively.

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { invoke, runCapability, gatewayGenerateText } from "../ai-platform/gateway.js";
import { createAIRequest, textPart, toLegacyText } from "../ai-platform/contract/index.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

function fakeDeps({ adapter } = {}) {
  const mock = adapter || new MockAdapter(); // echoes prompt by default
  return {
    resolve: async ({ capabilityKey }) => ({
      capabilityKey: capabilityKey || "legacy.generate_text",
      providerKey: "mock",
      adapterType: "mock",
      providerConfig: { key: "mock", defaultModel: "mock-1" },
      model: "mock-1",
      profileKey: "balanced",
      profileParams: null,
      promptKey: null,
      requires: null,
    }),
    getAdapterFor: () => mock,
    checkPolicies: async () => ({ allowed: true }),
    resolvePromptTemplate: async () => null,
    logAiRequest: async () => {},
    resolveCompatibility: () => ({ ok: true, gaps: [], checked: false }),
  };
}

test("invoke() returns a valid Contract v2 AIResponse", async () => {
  const req = createAIRequest({ capability: "meeting_intelligence", input: [textPart({ text: "hi" })] });
  const res = await invoke(req, fakeDeps());
  assert.equal(res.contractVersion, "2.0");
  assert.equal(res.status, "succeeded");
  assert.equal(res.output[0].kind, "text");
  assert.equal(toLegacyText(res), "hi"); // mock echoes the prompt
  assert.equal(res.resolution.provider, "mock");
  assert.ok(res.execution.correlationId);
  assert.equal(res.requestId, req.requestId);
});

test("gatewayGenerateText shim returns a plain string identical to legacy shape", async () => {
  assert.equal(await gatewayGenerateText({ prompt: "hello" }, fakeDeps()), "hello");
  // messages form round-trips through Parts and back
  const out = await gatewayGenerateText(
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
    fakeDeps()
  );
  assert.equal(out, "a\nb");
});

test("runCapability shim preserves the {text, meta} contract", async () => {
  const r = await runCapability({ capability: "c", prompt: "yo" }, fakeDeps());
  assert.equal(r.text, "yo");
  assert.equal(r.meta.capability, "c");
  assert.equal(r.meta.provider, "mock");
  assert.equal(r.meta.model, "mock-1");
  assert.ok(typeof r.meta.latencyMs === "number");
});

test("forward-compat: non-text (future modality) parts are ignored on the text path, not errored", async () => {
  const req = createAIRequest({
    capability: "c",
    input: [{ kind: "image", ref: { store: "url", ref: "http://x" } }, textPart({ text: "only text used" })],
  });
  const res = await invoke(req, fakeDeps());
  assert.equal(res.status, "succeeded");
  assert.equal(toLegacyText(res), "only text used");
});

test("execution errors rethrow the ORIGINAL provider error (parity with legacy)", async () => {
  const boom = new MockAdapter({
    script: () => {
      throw Object.assign(new Error("provider boom"), { code: "XYZ" });
    },
  });
  await assert.rejects(
    () => gatewayGenerateText({ prompt: "x" }, fakeDeps({ adapter: boom })),
    (e) => e.message === "provider boom" && e.code === "XYZ"
  );
});
