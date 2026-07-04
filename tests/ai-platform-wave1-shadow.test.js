// tests/ai-platform-wave1-shadow.test.js
//
// Epic B Wave 1 shadow/parity self-test for the 4 internal read-only intelligence
// capabilities. Hermetic: legacy output = golden; the v2 path runs through the
// REAL gateway invoke() with an injected MockAdapter that returns the same golden
// output (simulating "same provider → same output"). Real-provider parity numbers
// are produced by running this same harness in staging. No DB, no network.
//
// Proves per capability: output parity, latency capture, cost capture, safety
// capture, provider negotiation, v2 discarded, not exposed to users.

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { invoke } from "../ai-platform/gateway.js";
import { getCapability } from "../ai-platform/capabilities/registry.js";
import { WAVE1_CAPABILITIES, buildV2Request } from "../ai-platform/shadow/wave1.js";
import { runShadow } from "../ai-platform/shadow/shadowRunner.js";
import { loadGolden } from "../ai-platform/testing/index.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

// Real negotiation runs (compatibilityResolver is pure); only DB-touching deps are faked.
function v2Deps(goldenOutput) {
  return {
    resolve: async ({ capabilityKey }) => ({
      capabilityKey,
      providerKey: "groq",
      adapterType: "mock",
      providerConfig: { key: "groq", defaultModel: "llama-3.3-70b-versatile" },
      model: "llama-3.3-70b-versatile",
      profileKey: "balanced",
      profileParams: null,
      promptKey: null,
      requires: getCapability(capabilityKey)?.requires,
    }),
    getAdapterFor: () => new MockAdapter({ fixedText: goldenOutput }),
    checkPolicies: async () => ({ allowed: true }),
    resolvePromptTemplate: async () => null,
    logAiRequest: async () => {},
    // resolveCompatibility intentionally NOT overridden → real negotiation runs.
  };
}

for (const capability of WAVE1_CAPABILITIES) {
  test(`Wave1 shadow · ${capability}: v2 matches legacy, is discarded, and is not exposed`, async () => {
    const golden = loadGolden(capability, "case-1");
    assert.ok(golden, `golden fixture for ${capability} exists`);

    const report = await runShadow({
      capability,
      golden,
      legacyExecute: async () => golden.output, // captured legacy output (ground truth)
      v2Execute: async () => invoke(buildV2Request(capability, golden.input), v2Deps(golden.output)),
    });

    // Output parity
    assert.equal(report.parity.pass, true, `${capability} parity must pass`);
    assert.equal(report.parity.score, 1, `${capability} v2 output must equal legacy`);

    // Latency captured (both paths timed)
    assert.equal(typeof report.latency.v2Ms, "number");
    assert.equal(typeof report.latency.legacyMs, "number");

    // Cost captured (groq priced, permissive)
    assert.equal(report.cost.currency, "USD");
    assert.ok(report.cost.estimated >= 0 && report.cost.actual >= 0);

    // Safety captured (permissive; benign inputs → allow)
    assert.equal(report.safety.enforced, false);
    assert.ok(["allow", "flag", "block"].includes(report.safety.inputVerdict));

    // Provider negotiation ran (groq satisfies these capabilities' requires{})
    assert.ok(report.negotiation, "negotiation present");
    assert.equal(report.negotiation.ok, true, `${capability} negotiation OK on groq`);

    // Shadow guarantees
    assert.equal(report.v2Discarded, true);
    assert.equal(report.exposedToUser, false);
    assert.equal(report.v2Error, null);
    assert.equal(report.resolution.provider, "groq");
  });
}

test("Wave1 covers exactly the 4 internal read-only intelligence capabilities", () => {
  assert.deepEqual([...WAVE1_CAPABILITIES].sort(), [
    "enterprise_intelligence",
    "executive_summary",
    "forecast_reasoning",
    "llm_explanation",
  ]);
});
