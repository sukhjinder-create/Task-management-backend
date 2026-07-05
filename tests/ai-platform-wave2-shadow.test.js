// tests/ai-platform-wave2-shadow.test.js
//
// Epic B remainder — shadow/parity for all remaining backend generateText-based
// capabilities. Hermetic (legacy=golden; v2 = real gateway invoke() with an
// injected MockAdapter returning the same golden output; real negotiation runs).
// Real-provider numbers come from running this harness in staging. No DB/network.

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { invoke } from "../ai-platform/gateway.js";
import { getCapability, listCapabilities, LEGACY_CAPABILITY_KEY } from "../ai-platform/capabilities/registry.js";
import { buildV2Request } from "../ai-platform/shadow/wave1.js";
import { WAVE2_CAPABILITIES } from "../ai-platform/shadow/wave2.js";
import { WAVE2_GOLDEN } from "../ai-platform/shadow/wave2.golden.js";
import { WAVE1_CAPABILITIES } from "../ai-platform/shadow/wave1.js";
import { runShadow } from "../ai-platform/shadow/shadowRunner.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

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
    // real resolveCompatibility → real negotiation
  };
}

for (const g of WAVE2_GOLDEN) {
  test(`Epic B shadow · ${g.capability}: parity + all dimensions, discarded, not exposed`, async () => {
    assert.ok(getCapability(g.capability), `${g.capability} is registered`);
    const report = await runShadow({
      capability: g.capability,
      golden: { output: g.output },
      legacyExecute: async () => g.output,
      v2Execute: async () => invoke(buildV2Request(g.capability, g.input), v2Deps(g.output)),
    });

    assert.equal(report.parity.pass, true, `${g.capability} parity`);
    assert.equal(report.parity.score, 1);
    assert.equal(typeof report.latency.v2Ms, "number");
    assert.equal(report.cost.currency, "USD");
    assert.ok(report.cost.estimated >= 0 && report.cost.actual >= 0);
    assert.equal(report.safety.enforced, false);
    assert.ok(["allow", "flag", "block"].includes(report.safety.inputVerdict));
    assert.ok(report.negotiation && report.negotiation.ok === true, `${g.capability} negotiation OK on groq`);
    assert.equal(report.v2Discarded, true);
    assert.equal(report.exposedToUser, false);
    assert.equal(report.v2Error, null);
    assert.equal(report.resolution.provider, "groq");
  });
}

test("golden set covers every Wave-2 capability", () => {
  assert.deepEqual(
    WAVE2_GOLDEN.map((g) => g.capability).sort(),
    [...WAVE2_CAPABILITIES].sort()
  );
});

test("Wave 1 + Wave 2 cover ALL backend capabilities (excl. legacy shim + ai-task chat_away_responder)", () => {
  const registered = listCapabilities().map((c) => c.key);
  const covered = new Set([...WAVE1_CAPABILITIES, ...WAVE2_CAPABILITIES]);
  // Out of the backend generateText waves: the legacy shim + the ai-task (Epic B′)
  // capabilities, which are unified via the external invoke door, not these waves.
  const outOfScope = new Set([
    LEGACY_CAPABILITY_KEY, "chat_away_responder",
    "ai_task_creation", "decision_extraction", "summarization", "report_generation", "reasoning_summary",
  ]);
  const uncovered = registered.filter((k) => !covered.has(k) && !outOfScope.has(k));
  assert.deepEqual(uncovered, [], `every backend capability is covered; leftover: ${uncovered.join(",")}`);
});
