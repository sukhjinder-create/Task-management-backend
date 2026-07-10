// tests/ai-studio-uplift.test.js
//
// Enterprise uplift self-test: prompt-variable validation (extract / proxy-record /
// validate+force) and orchestrator run metrics. Hermetic — pure functions only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVariables, fallbackInfo, validatePromptBody } from "../ai-platform/studio/capabilityPrompt.service.js";
import { recordRun, getOrchestratorMetrics, _resetOrchestratorMetrics } from "../ei/orchestrator/metrics.js";

test("extractVariables: finds unique {{var}} names", () => {
  assert.deepEqual(extractVariables("Hi {{name}}, review {{ transcript }} and {{name}}."), ["name", "transcript"]);
  assert.deepEqual(extractVariables("no vars"), []);
  assert.deepEqual(extractVariables(null), []);
});

test("fallbackInfo: proxy records the variables a code fallbackPrompt reads and marks them", () => {
  const cap = { fallbackPrompt: (v) => `Summarize this meeting:\n${v.transcript}\nAudience: ${v.audience}` };
  const fb = fallbackInfo(cap);
  assert.ok(fb.body.includes("{{transcript}}") && fb.body.includes("{{audience}}"));
  assert.deepEqual(fb.variables.sort(), ["audience", "transcript"]);
  // Function that needs a real array → falls back to {} render but still no crash.
  const capArr = { fallbackPrompt: (v) => v.items.map((x) => x).join(",") };
  const fb2 = fallbackInfo(capArr);
  assert.ok(Array.isArray(fb2.variables));
  // No fallback at all.
  assert.deepEqual(fallbackInfo({}), { body: null, variables: [] });
});

test("validatePromptBody: blocks missing variables unless forced", () => {
  const required = ["transcript", "audience"];
  assert.deepEqual(validatePromptBody({ requiredVariables: required, body: "use {{transcript}} for {{audience}}" }), { ok: true, missing: [] });
  const bad = validatePromptBody({ requiredVariables: required, body: "just do it" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ["transcript", "audience"]);
  assert.equal(validatePromptBody({ requiredVariables: required, body: "just do it", force: true }).ok, true);
});

test("orchestrator metrics: counters, ring buffer, failure tracking", () => {
  _resetOrchestratorMetrics();
  recordRun({ workspaceId: "w1", durationMs: 12, ok: true, counts: { events: 5, recommendations: 1 } });
  recordRun({ workspaceId: "w2", durationMs: 30, ok: false, error: "boom" });
  const m = getOrchestratorMetrics();
  assert.equal(m.runs, 2);
  assert.equal(m.failures, 1);
  assert.equal(m.failureRate, 0.5);
  assert.equal(m.lastError.workspaceId, "w2");
  assert.equal(m.recent.length, 2);
  assert.equal(m.recent[0].error, "boom");     // newest first
  assert.equal(m.recent[1].events, 5);
  for (let i = 0; i < 60; i++) recordRun({ workspaceId: "w1", durationMs: 1, ok: true });
  assert.equal(getOrchestratorMetrics().recent.length, 50); // ring buffer capped
  _resetOrchestratorMetrics();
});
