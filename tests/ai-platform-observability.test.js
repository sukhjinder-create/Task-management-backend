// tests/ai-platform-observability.test.js
//
// P5 self-test: trace/span/trigger/source-module propagation through invoke()
// (Contract v2 §12). Hermetic — telemetry is injected to CAPTURE the emitted
// record (no DB), and the adapter is a mock (no network).

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { invoke } from "../ai-platform/gateway.js";
import { createAIRequest, textPart, newTraceContext, createTrigger } from "../ai-platform/contract/index.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

function depsCapturing(captured, { adapter } = {}) {
  const mock = adapter || new MockAdapter();
  return {
    resolve: async ({ capabilityKey }) => ({
      capabilityKey: capabilityKey || "legacy.generate_text",
      providerKey: "mock", adapterType: "mock",
      providerConfig: { key: "mock", defaultModel: "mock-1" },
      model: "mock-1", profileKey: "balanced", profileParams: null, promptKey: null, requires: null,
    }),
    getAdapterFor: () => mock,
    checkPolicies: async () => ({ allowed: true }),
    resolvePromptTemplate: async () => null,
    logAiRequest: async (r) => { captured.push(r); },
    resolveCompatibility: () => ({ ok: true, gaps: [], checked: false }),
  };
}

test("invoke propagates trace/trigger/source-module to telemetry AND the response", async () => {
  const captured = [];
  const tracing = newTraceContext();
  const req = createAIRequest({
    capability: "meeting_intelligence",
    input: [textPart({ text: "x" })],
    tracing,
    trigger: createTrigger({ eventType: "meeting.ended", entityRef: { type: "huddle", id: "h1" } }),
    executionContext: { sourceModule: "huddleIntelligenceWorker", parentRequestId: "parent-1" },
  });

  const res = await invoke(req, depsCapturing(captured));

  // Telemetry record carries the full causal chain
  const rec = captured[0];
  assert.equal(rec.traceId, tracing.traceId);
  assert.equal(rec.spanId, tracing.spanId);
  assert.equal(rec.triggerType, "meeting.ended");
  assert.equal(rec.sourceModule, "huddleIntelligenceWorker");
  assert.equal(rec.parentRequestId, "parent-1");
  assert.equal(rec.status, "success");

  // Response.execution exposes the trace tree + business trigger
  assert.equal(res.execution.trace.traceId, tracing.traceId);
  assert.equal(res.execution.trigger.eventType, "meeting.ended");
  assert.equal(res.execution.sourceModule, "huddleIntelligenceWorker");
});

test("failures are traced too (status=failure with the same trace context)", async () => {
  const captured = [];
  const boom = new MockAdapter({ script: () => { throw new Error("down"); } });
  const tracing = newTraceContext();
  const req = createAIRequest({ capability: "c", input: [textPart({ text: "x" })], tracing });

  await assert.rejects(() => invoke(req, depsCapturing(captured, { adapter: boom })));
  const rec = captured[0];
  assert.equal(rec.status, "failure");
  assert.equal(rec.traceId, tracing.traceId);
  assert.equal(rec.failureReason, "down");
});

test("absent trace context falls back to a generated correlation id (no crash)", async () => {
  const captured = [];
  // Build a request-like object WITHOUT tracing to prove graceful fallback.
  const res = await invoke(
    { capability: "c", input: [textPart({ text: "x" })] },
    depsCapturing(captured)
  );
  assert.equal(res.status, "succeeded");
  assert.ok(captured[0].traceId, "a correlation/trace id is always present");
});
