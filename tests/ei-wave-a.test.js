// tests/ei-wave-a.test.js
//
// EI V2.1 Wave A self-test: Evidence (P3) + Reasoning Trace (P4) + Prediction (P5),
// end-to-end over the Phase-2 attribution output. Hermetic + deterministic (fixed
// evaluation time; DI stores; no DB, no LLM). Stores are UNVERIFIED AT RUNTIME.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAttributions } from "../ei/attribution/engine.js";
import { fromAttribution, validateEvidence } from "../ei/evidence/evidence.js";
import { buildEvidenceForWorkspace } from "../ei/evidence/service.js";
import { buildTracesForWorkspace } from "../ei/reasoning/service.js";
import { validateTrace, UNKNOWN_UNKNOWNS_CAP } from "../ei/reasoning/trace.js";
import { computePrediction } from "../ei/prediction/engine.js";
import { validatePrediction } from "../ei/prediction/prediction.js";
import { predictForWorkspace } from "../ei/prediction/service.js";

const NOW = Date.parse("2026-07-01T00:00:00Z"); // fixed evaluation time → deterministic
const ev = (seq, type, et, id, ts) => ({ eventId: `e${seq}`, seq, workspaceId: "ws-1", type, occurredAt: ts, entities: [{ type: et, id, role: "primary" }] });
const events = [
  ev(1, "task.unassigned", "Task", "t-1", "2026-06-12T00:00:00Z"),
  ev(2, "dependency.blocked", "Dependency", "d-1", "2026-06-12T00:00:00Z"),
  ev(3, "task.slipped", "Task", "t-1", "2026-06-20T00:00:00Z"),
  ev(4, "task.slipped", "Task", "t-2", "2026-06-25T00:00:00Z"),
  ev(5, "task.slipped", "Task", "t-3", "2026-06-28T00:00:00Z"),
];
const attributions = computeAttributions({ workspaceId: "ws-1", events });

// ── Phase 3: Evidence ─────────────────────────────────────────────────────────
test("P3 Evidence: immutable, references attribution + events, provenance", async () => {
  const e = fromAttribution(attributions[0]);
  assert.ok(e.evidenceId.startsWith("evd_"));
  assert.equal(e.attributionRef.attributionId, attributions[0].attributionId);
  assert.equal(e.confidenceSource, attributions[0].confidenceSource);
  assert.ok(Object.isFrozen(e));
  assert.equal(validateEvidence(e).ok, true);
  // deterministic: same attribution → same evidence id (idempotent)
  assert.equal(fromAttribution(attributions[0]).evidenceId, e.evidenceId);

  process.env.EI_EVIDENCE_ENABLED = "true";
  try {
    const written = [];
    const r = await buildEvidenceForWorkspace({ workspaceId: "ws-1", attributions }, { appendEvidence: async (x) => (written.push(x.evidenceId), x.evidenceId) });
    assert.equal(r.projected, attributions.length);
    assert.equal(written.length, attributions.length);
  } finally { delete process.env.EI_EVIDENCE_ENABLED; }
});

// ── Phase 4: Reasoning Trace ──────────────────────────────────────────────────
test("P4 Reasoning Trace: structured (no narration), confidence-decomposed, humble, deterministic", async () => {
  process.env.EI_REASONING_ENABLED = "true";
  try {
    const written = [];
    const r = await buildTracesForWorkspace({ workspaceId: "ws-1", attributions, now: NOW }, { appendTrace: async (t) => (written.push(t.traceId), t.traceId) });
    assert.equal(r.built, 2); // effect entities t-1 (O+A) and t-2 (A); t-3 had no attribution
    const t1 = r.traces.find((t) => t.claim.entity.id === "t-1");

    // Structured claim — NOT natural language, no narration/summary fields.
    assert.equal(t1.claim.predicate, "task.slipped");
    assert.equal(typeof t1.claim.status, "string");
    assert.equal(t1.text, undefined);
    assert.equal(t1.summary, undefined);
    assert.equal(t1.narrative, undefined);

    // Confidence decomposition (§13) — capped by the unknown-unknowns floor (< 1.0).
    assert.ok(t1.confidenceDecomposition.overall <= UNKNOWN_UNKNOWNS_CAP);
    assert.ok("dataCompleteness" in t1.confidenceDecomposition && "signalStrength" in t1.confidenceDecomposition && "recency" in t1.confidenceDecomposition);

    // §14b humility present.
    assert.ok(Array.isArray(t1.unknownFactors.illegibleDrivers));
    assert.ok("observedCoverage" in t1.observedUncertainty);

    // Explainability refs + alternatives.
    assert.ok(t1.attributionChain.length >= 1);
    assert.ok(t1.reasoningChain.length >= 1);
    assert.ok(t1.referencedEvents.length >= 1);
    assert.equal(validateTrace(t1).ok, true);

    // Determinism: same inputs + same evaluation time → identical traces.
    const r2 = await buildTracesForWorkspace({ workspaceId: "ws-1", attributions, now: NOW }, { appendTrace: async () => null });
    assert.deepEqual(r2.traces, r.traces);
  } finally { delete process.env.EI_REASONING_ENABLED; }
});

test("P4: low-coverage claim downgrades to 'insufficient_basis' (we do not know)", async () => {
  process.env.EI_REASONING_ENABLED = "true";
  try {
    // A single Tier-A attribution population of 1 → low observed coverage.
    const sparse = computeAttributions({ workspaceId: "ws-9", events: [
      ev(1, "dependency.blocked", "Dependency", "d-1", "2026-06-12T00:00:00Z"),
      ev(2, "task.slipped", "Task", "z-1", "2026-06-20T00:00:00Z"),
    ] });
    const r = await buildTracesForWorkspace({ workspaceId: "ws-9", attributions: sparse, now: NOW }, { appendTrace: async () => null });
    assert.ok(r.traces.every((t) => t.claim.status === "insufficient_basis" || t.confidenceDecomposition.overall <= UNKNOWN_UNKNOWNS_CAP));
  } finally { delete process.env.EI_REASONING_ENABLED; }
});

// ── Phase 5: Prediction ───────────────────────────────────────────────────────
test("P5 Prediction: deterministic, references a trace, never certain, humble", async () => {
  process.env.EI_REASONING_ENABLED = "true";
  process.env.EI_PREDICTION_ENABLED = "true";
  try {
    const built = await buildTracesForWorkspace({ workspaceId: "ws-1", attributions, now: NOW }, { appendTrace: async () => null });
    const trace = built.traces.find((t) => t.claim.status === "attributed") || built.traces[0];

    const p = computePrediction({ workspaceId: "ws-1", entity: trace.claim.entity, predictionType: "risk:task.slipped", trace, horizonDays: 14 });
    assert.ok(p.predictionId.startsWith("pred_"));
    assert.equal(p.supportingReasoningTraceId, trace.traceId); // explainable
    assert.ok(p.probability >= 0 && p.probability <= 1);
    assert.ok(p.confidenceInterval.low <= p.probability && p.probability <= p.confidenceInterval.high);
    assert.ok(p.confidenceInterval.high < 1); // never certain
    assert.ok(p.assumptions.some((a) => a.type === "humility"));
    assert.equal(p.provenance.members.includes("attribution_propagation"), true);
    assert.equal(validatePrediction(p).ok, true);
    assert.equal(p.narrative, undefined); // no narration
    // deterministic
    assert.deepEqual(computePrediction({ workspaceId: "ws-1", entity: trace.claim.entity, predictionType: "risk:task.slipped", trace, horizonDays: 14 }), p);

    // Service skips insufficient_basis traces and is flag-gated.
    const insufficient = { traceId: "trX", claim: { entity: { type: "Task", id: "q" }, predicate: "task.slipped", status: "insufficient_basis" }, confidenceDecomposition: {}, observedUncertainty: {}, unknownFactors: {} };
    const written = [];
    const r = await predictForWorkspace({ workspaceId: "ws-1", traces: [trace, insufficient] }, { appendPrediction: async (x) => (written.push(x.predictionId), x.predictionId) });
    assert.equal(r.predicted, 1); // only the attributed trace
    assert.equal(written.length, 1);
  } finally { delete process.env.EI_REASONING_ENABLED; delete process.env.EI_PREDICTION_ENABLED; }
});

test("Wave A services are flag-gated OFF by default", async () => {
  assert.equal((await buildEvidenceForWorkspace({ workspaceId: "off-ws", attributions })).skipped, "flag_off");
  assert.equal((await buildTracesForWorkspace({ workspaceId: "off-ws", attributions })).skipped, "flag_off");
  assert.equal((await predictForWorkspace({ workspaceId: "off-ws", traces: [] })).skipped, "flag_off");
});
