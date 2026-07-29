// tests/ai-platform-external-invoke.test.js
//
// Unification self-test: the single external door (externalInvoke) runs the full
// Contract-v2 pipeline and returns { text, response } for external services
// (ai-task). Hermetic via DI (no network/DB). Proves ai-task's traffic, when
// unified, flows through the ONE platform path.

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { externalInvoke } from "../ai-platform/api/invokeService.js";
import { getCapability } from "../ai-platform/capabilities/registry.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

const deps = (out) => ({
  resolve: async ({ capabilityKey }) => ({
    capabilityKey, providerKey: "groq", adapterType: "mock",
    providerConfig: { key: "groq", defaultModel: "llama-3.3-70b-versatile" }, model: "llama-3.3-70b-versatile",
    profileKey: "balanced", profileParams: null, promptKey: null, requires: getCapability(capabilityKey)?.requires,
  }),
  getAdapterFor: () => new MockAdapter({ fixedText: out }),
  checkPolicies: async () => ({ allowed: true }),
  resolvePromptTemplate: async () => null,
  logAiRequest: async () => {},
});

test("ai-task capabilities are registered in the ONE platform", () => {
  for (const k of ["chat_away_responder", "ai_task_creation", "decision_extraction", "summarization", "report_generation", "reasoning_summary"]) {
    assert.ok(getCapability(k), `${k} registered`);
  }
});

test("externalInvoke runs the full pipeline and returns text + response envelope", async () => {
  const out = await externalInvoke({ capability: "chat_away_responder", prompt: "Is Sam available?" }, deps("Sam is away; back at 3pm."));
  assert.equal(out.text, "Sam is away; back at 3pm.");
  assert.equal(out.response.status, "succeeded");
  assert.equal(out.response.resolution.provider, "groq");
  assert.equal(out.response.cost.currency, "USD");
  assert.ok(out.response.safety);
  assert.ok(out.response.correlationId);
});

test("ai_task_creation (json) negotiates OK through the platform", async () => {
  const out = await externalInvoke({ capability: "ai_task_creation", prompt: "Create: fix bug by Fri", overrides: { json: true } }, deps('{"title":"fix bug"}'));
  assert.equal(out.response.status, "succeeded");
  assert.equal(out.response.negotiation?.ok, true);
});
