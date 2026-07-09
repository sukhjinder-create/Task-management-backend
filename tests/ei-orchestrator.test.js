// tests/ei-orchestrator.test.js
//
// Verifies the EI orchestrator wires the full deterministic pipeline end-to-end:
// events → attribution → evidence → reasoning → prediction → recommendation, persisting
// each stage. Hermetic (injected stores; canary flag enables all EI stages for the test
// workspace); deterministic (fixed evaluation time); idempotent (re-run converges).

import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipelineForWorkspace } from "../ei/orchestrator/pipeline.js";
import { orchestrateWorkspace } from "../ei/orchestrator/service.js";

const WS = "ws-orch";
const NOW = Date.parse("2026-07-09T00:00:00Z");
const ev = (seq, type, et, id, ts) => ({ eventId: `e${seq}`, seq, workspaceId: WS, type, occurredAt: ts, entities: [{ type: et, id, role: "primary" }] });
const EVENTS = [
  ev(1, "task.unassigned", "Task", "t-1", "2026-06-12T00:00:00Z"),
  ev(2, "dependency.blocked", "Dependency", "d-1", "2026-06-12T00:00:00Z"),
  ev(3, "task.slipped", "Task", "t-1", "2026-06-20T00:00:00Z"),
  ev(4, "task.slipped", "Task", "t-2", "2026-06-25T00:00:00Z"),
  ev(5, "task.slipped", "Task", "t-3", "2026-06-28T00:00:00Z"),
];

function collector() {
  const w = { attributions: [], evidence: [], traces: [], predictions: [], recommendations: [] };
  return {
    w,
    deps: {
      readEvents: async () => EVENTS.map((e) => ({ event_id: e.eventId, seq: e.seq, workspace_id: WS, type: e.type, occurred_at: e.occurredAt, entities_json: JSON.stringify(e.entities) })),
      appendAttribution: async (a) => (w.attributions.push(a.attributionId), a.attributionId),
      appendEvidence: async (e) => (w.evidence.push(e.evidenceId), e.evidenceId),
      appendTrace: async (t) => (w.traces.push(t.traceId), t.traceId),
      appendPrediction: async (p) => (w.predictions.push(p.predictionId), p.predictionId),
      appendRecommendation: async (r) => (w.recommendations.push(r.recommendationId), r.recommendationId),
    },
  };
}

test("orchestrator runs the full pipeline and persists every stage (canary-enabled)", async () => {
  process.env.EI_ENABLED_WORKSPACES = WS; // enables every EI stage flag for this workspace
  try {
    const { w, deps } = collector();
    const r = await orchestrateWorkspace({ workspaceId: WS, now: NOW }, deps);
    assert.notEqual(r.skipped, "flag_off");
    assert.ok(r.attributions >= 1, "attributions produced");
    assert.ok(w.attributions.length >= 1, "attributions persisted");
    assert.ok(w.evidence.length >= 1, "evidence persisted");
    assert.ok(w.traces.length >= 1, "traces persisted");
    assert.ok(w.predictions.length >= 1, "predictions persisted");
    assert.ok(w.recommendations.length >= 1, "recommendations persisted");
    assert.equal(r.stagesSkipped, 0, "no stage was flag-gated off");

    // Deterministic + idempotent: a second run yields identical counts.
    const { w: w2, deps: deps2 } = collector();
    const r2 = await runPipelineForWorkspace({ workspaceId: WS, now: NOW }, deps2);
    assert.deepEqual([r2.attributions, r2.traces, r2.predictions, r2.recommendations], [r.attributions, r.traces, r.predictions, r.recommendations]);
    assert.deepEqual(w2.recommendations.sort(), w.recommendations.sort());
  } finally { delete process.env.EI_ENABLED_WORKSPACES; }
});

test("orchestrator is flag-gated OFF by default", async () => {
  const { deps } = collector();
  assert.equal((await orchestrateWorkspace({ workspaceId: "someone-else", now: NOW }, deps)).skipped, "flag_off");
});
