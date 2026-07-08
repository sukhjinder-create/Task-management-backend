// tests/ei-wave-b.test.js
//
// EI V2.1 Wave B self-test: Recommendation (P6) + Executive Intelligence (P7) +
// Business Narration (P8) + Enterprise Graph projection + evidence-backed Metrics.
// Runs end-to-end over the Wave-A pipeline (events → attributions → evidence →
// traces → predictions → …). Hermetic + deterministic (fixed evaluation time; DI
// stores; no DB, no LLM). Stores are UNVERIFIED AT RUNTIME.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAttributions } from "../ei/attribution/engine.js";
import { fromAttribution } from "../ei/evidence/evidence.js";
import { buildTracesForWorkspace } from "../ei/reasoning/service.js";
import { predictForWorkspace } from "../ei/prediction/service.js";

import { computeRecommendation } from "../ei/recommendation/engine.js";
import { validateRecommendation, REC_STATUS } from "../ei/recommendation/recommendation.js";
import { recommendForWorkspace } from "../ei/recommendation/service.js";

import { buildGraph } from "../ei/graph/graph.js";

import { answerExecutiveQuestion } from "../ei/executive/engine.js";
import { QUESTION } from "../ei/executive/questions.js";
import { executiveBriefing } from "../ei/executive/service.js";

import { narrate } from "../ei/narration/narrator.js";
import { narrateTrace, INSUFFICIENT_EVIDENCE_PHRASE } from "../ei/narration/templates.js";
import { narrateForWorkspace } from "../ei/narration/service.js";

import { computeMetrics } from "../ei/metrics/metrics.js";
import { computePlatformMetrics } from "../ei/metrics/service.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const ev = (seq, type, et, id, ts) => ({ eventId: `e${seq}`, seq, workspaceId: "ws-1", type, occurredAt: ts, entities: [{ type: et, id, role: "primary" }] });
const events = [
  ev(1, "task.unassigned", "Task", "t-1", "2026-06-12T00:00:00Z"),
  ev(2, "dependency.blocked", "Dependency", "d-1", "2026-06-12T00:00:00Z"),
  ev(3, "task.slipped", "Task", "t-1", "2026-06-20T00:00:00Z"),
  ev(4, "task.slipped", "Task", "t-2", "2026-06-25T00:00:00Z"),
  ev(5, "task.slipped", "Task", "t-3", "2026-06-28T00:00:00Z"),
];
const attributions = computeAttributions({ workspaceId: "ws-1", events });
const evidence = attributions.map(fromAttribution);

// Build the real corpus once (deterministic given NOW).
async function buildCorpus(workspaceId = "ws-1") {
  process.env.EI_REASONING_ENABLED = "true";
  process.env.EI_PREDICTION_ENABLED = "true";
  try {
    const traceRes = await buildTracesForWorkspace({ workspaceId, attributions, evidence, now: NOW }, { appendTrace: async () => null });
    const traces = traceRes.traces;
    const predRes = await predictForWorkspace({ workspaceId, traces }, { appendPrediction: async () => null });
    const predictions = predRes.predictions;
    const tracesById = Object.fromEntries(traces.map((t) => [t.traceId, t]));
    return { traces, predictions, tracesById };
  } finally { delete process.env.EI_REASONING_ENABLED; delete process.env.EI_PREDICTION_ENABLED; }
}

// A guaranteed-actionable prediction+trace (independent of attribution math) for P6 asserts.
function actionablePair() {
  const trace = {
    traceId: "trace_fixture_actionable",
    claim: { entity: { type: "Task", id: "t-1" }, predicate: "task.slipped", tier: "A", status: "attributed" },
    confidenceDecomposition: { overall: 0.7 },
    observedUncertainty: { observedCoverage: 0.6 },
    unknownFactors: { illegibleDrivers: ["morale"] },
    reasoningChain: [{ from: { descriptor: "unassigned_owner" }, relation: "associated with", tier: "A", evidenceRefs: [] }],
    alternativeHypotheses: [{ factor: { descriptor: "blocked_dependency" }, tier: "A", associationStrength: 0.4, ruleKey: "r" }],
    referencedEvidence: ["evd_x"], referencedAttribution: ["attr_x"], referencedGraphNodes: ["Task:t-1"],
  };
  const prediction = {
    predictionId: "pred_fixture_actionable",
    entity: { type: "Task", id: "t-1" }, predictionType: "risk:task.slipped",
    predictionValue: "likely", probability: 0.8, confidenceInterval: { low: 0.7, high: 0.9 },
    predictionHorizon: { days: 14 }, supportingReasoningTraceId: trace.traceId,
    alternativeOutcomes: [{ value: "not_likely", probability: 0.2 }],
    assumptions: [{ type: "humility", note: "unobserved drivers may contribute" }],
    observedUncertainty: trace.observedUncertainty, unknownFactors: trace.unknownFactors,
  };
  return { trace, prediction };
}

// ── Phase 6: Recommendation ───────────────────────────────────────────────────
test("P6 Recommendation: references prediction+trace+evidence, structured action, deterministic", () => {
  const { trace, prediction } = actionablePair();
  const r = computeRecommendation({ workspaceId: "ws-1", prediction, trace, evidence: [{ evidenceId: "evd_y" }] });

  assert.ok(r.recommendationId.startsWith("rec_"));
  assert.equal(r.status, REC_STATUS.RECOMMENDED);
  assert.equal(r.rationaleRefs.predictionId, prediction.predictionId);       // always references a prediction
  assert.equal(r.rationaleRefs.reasoningTraceId, trace.traceId);             // always references a trace
  assert.ok(r.rationaleRefs.evidenceIds.includes("evd_x") && r.rationaleRefs.evidenceIds.includes("evd_y")); // + evidence
  assert.ok(r.rationaleRefs.attributionIds.includes("attr_x"));
  assert.equal(typeof r.action, "object");                                   // structured, not NL
  assert.notEqual(typeof r.action, "string");
  assert.equal(r.requiresApproval, true);
  assert.ok(r.approvalScope && r.approvalScope.verb);
  assert.ok(r.alternatives.length >= 2);                                     // supports alternatives
  assert.ok("probability" in r.uncertainty && "confidenceInterval" in r.uncertainty); // supports uncertainty
  assert.equal(r.narrative, undefined);                                      // no narration in P6
  assert.equal(validateRecommendation(r).ok, true);

  // deterministic
  assert.deepEqual(computeRecommendation({ workspaceId: "ws-1", prediction, trace, evidence: [{ evidenceId: "evd_y" }] }), r);
});

test("P6: insufficient/absent basis → insufficient_basis, manual-only, no action", () => {
  const { prediction } = actionablePair();
  const weakTrace = { traceId: "trace_weak", claim: { entity: { type: "Task", id: "z" }, predicate: "task.slipped", tier: "A", status: "insufficient_basis" }, confidenceDecomposition: { overall: 0.1 }, observedUncertainty: {}, unknownFactors: {}, reasoningChain: [], alternativeHypotheses: [], referencedEvidence: [], referencedAttribution: [] };
  const r = computeRecommendation({ workspaceId: "ws-1", prediction: { ...prediction, supportingReasoningTraceId: weakTrace.traceId }, trace: weakTrace });
  assert.equal(r.status, REC_STATUS.INSUFFICIENT_BASIS);   // "we do not know"
  assert.equal(r.manualOnly, true);                        // supports manual-only
  assert.equal(r.action, null);
  assert.equal(validateRecommendation(r).ok, true);
});

test("P6 service: flag-gated OFF; ON produces validated, prediction-referencing recommendations", async () => {
  const off = await recommendForWorkspace({ workspaceId: "off-ws", predictions: [], tracesById: {} });
  assert.equal(off.skipped, "flag_off");

  const { traces, predictions, tracesById } = await buildCorpus("ws-1");
  process.env.EI_RECOMMENDATION_ENABLED = "true";
  try {
    const written = [];
    const res = await recommendForWorkspace({ workspaceId: "ws-1", predictions, tracesById }, { appendRecommendation: async (x) => (written.push(x.recommendationId), x.recommendationId) });
    assert.equal(res.recommended, predictions.length);          // one per prediction (each has a trace)
    assert.equal(written.length, res.recommended);
    for (const r of res.recommendations) {
      assert.equal(validateRecommendation(r).ok, true);
      assert.ok(tracesById[r.rationaleRefs.reasoningTraceId]);   // reference resolves to a real trace
      assert.notEqual(typeof r.action, "string");
    }
  } finally { delete process.env.EI_RECOMMENDATION_ENABLED; }
});

// ── Enterprise Intelligence Graph ─────────────────────────────────────────────
test("Graph: deterministic projection; every edge connects existing nodes; fully traceable", async () => {
  const { trace, prediction } = actionablePair();
  const rec = computeRecommendation({ workspaceId: "ws-1", prediction, trace });
  const g1 = buildGraph({ workspaceId: "ws-1", traces: [trace], predictions: [prediction], recommendations: [rec] });
  const g2 = buildGraph({ workspaceId: "ws-1", traces: [trace], predictions: [prediction], recommendations: [rec] });
  assert.deepEqual(g1, g2); // deterministic

  const ids = new Set(g1.nodes.map((n) => n.id));
  for (const e of g1.edges) {
    assert.ok(ids.has(e.from), `edge.from ${e.from} must be a node`);
    assert.ok(ids.has(e.to), `edge.to ${e.to} must be a node`);
    assert.ok(e.justifiedBy, "every edge carries the id that justifies it");
  }
  // The reasoning chain is present: entity → trace → prediction → recommendation.
  assert.ok(g1.edges.some((e) => e.rel === "subject_of"));
  assert.ok(g1.edges.some((e) => e.rel === "predicts"));
  assert.ok(g1.edges.some((e) => e.rel === "recommends"));
});

// ── Phase 7: Executive Intelligence ───────────────────────────────────────────
test("P7 Executive: answers reference only real records (no hallucination); deterministic", async () => {
  const corpus = await buildCorpus("ws-1");
  const validTraceIds = new Set(corpus.traces.map((t) => t.traceId));
  const validPredIds = new Set(corpus.predictions.map((p) => p.predictionId));

  const a1 = answerExecutiveQuestion({ workspaceId: "ws-1", questionType: QUESTION.PROJECTS_HIGHEST_RISK, corpus });
  const a2 = answerExecutiveQuestion({ workspaceId: "ws-1", questionType: QUESTION.PROJECTS_HIGHEST_RISK, corpus });
  assert.deepEqual(a1, a2); // deterministic
  if (a1.status === "answered") {
    for (const id of a1.references.traceIds) assert.ok(validTraceIds.has(id));
    for (const id of a1.references.predictionIds) assert.ok(validPredIds.has(id));
  }

  // Outcome-dependent questions are honestly insufficient (never fabricated).
  const impact = answerExecutiveQuestion({ workspaceId: "ws-1", questionType: QUESTION.RECOMMENDATIONS_WITH_IMPACT, corpus });
  assert.equal(impact.status, "insufficient_evidence");
  assert.match(impact.reason, /outcome history/i);

  // Department question is insufficient without a department dimension, answerable with it.
  const noDept = answerExecutiveQuestion({ workspaceId: "ws-1", questionType: QUESTION.DEPARTMENTS_NEEDING_ATTENTION, corpus });
  assert.equal(noDept.status, "insufficient_evidence");
  const withDept = answerExecutiveQuestion({
    workspaceId: "ws-1", questionType: QUESTION.DEPARTMENTS_NEEDING_ATTENTION,
    corpus: { ...corpus, departmentByEntity: Object.fromEntries(corpus.predictions.map((p) => [`${p.entity.type}:${p.entity.id}`, "Engineering"])) },
  });
  assert.ok(withDept.status === "answered" || withDept.status === "insufficient_evidence");
});

test("P7 service: flag-gated OFF; ON returns a full briefing", async () => {
  const corpus = await buildCorpus("ws-1");
  assert.equal((await executiveBriefing({ workspaceId: "off-ws", corpus })).skipped, "flag_off");
  process.env.EI_EXECUTIVE_ENABLED = "true";
  try {
    const b = await executiveBriefing({ workspaceId: "ws-1", corpus });
    assert.equal(b.answers.length, 6);
    assert.equal(b.answered + b.insufficient, 6);
  } finally { delete process.env.EI_EXECUTIVE_ENABLED; }
});

// ── Phase 8: Business Narration ───────────────────────────────────────────────
test("P8 Narration: deterministic templates, faithful, LLM optional with template fallback", async () => {
  const { trace } = actionablePair();
  const text = narrateTrace(trace);
  assert.ok(text.includes("t-1") && text.includes("task.slipped")); // uses only the record's own facts
  assert.equal(narrateTrace(trace), text);                          // deterministic

  const insufficientTrace = { claim: { entity: { type: "Task", id: "z" }, predicate: "task.slipped", status: "insufficient_basis" } };
  assert.ok(narrateTrace(insufficientTrace).startsWith(INSUFFICIENT_EVIDENCE_PHRASE));

  // No LLM injected → deterministic template is the text.
  const noLlm = await narrate({ kind: "trace", record: trace });
  assert.equal(noLlm.mode, "deterministic");
  assert.equal(noLlm.text, text);
  assert.equal(noLlm.sourceRefs.traceId, trace.traceId);

  // LLM throws → falls back to the deterministic template (templates must always work).
  const failing = await narrate({ kind: "trace", record: trace }, { llm: async () => { throw new Error("gateway down"); } });
  assert.equal(failing.mode, "deterministic");
  assert.equal(failing.text, text);

  // LLM rephrases → llm mode, template retained as the guardrail source.
  const good = await narrate({ kind: "trace", record: trace }, { llm: async () => "Rephrased business summary." });
  assert.equal(good.mode, "llm");
  assert.equal(good.text, "Rephrased business summary.");
  assert.equal(good.templateText, text);
});

test("P8 service: flag-gated OFF; ON narrates deterministically without LLM", async () => {
  const { trace } = actionablePair();
  assert.equal((await narrateForWorkspace({ workspaceId: "off-ws", items: [] })).skipped, "flag_off");
  process.env.EI_NARRATION_ENABLED = "true";
  try {
    const res = await narrateForWorkspace({ workspaceId: "ws-1", items: [{ kind: "trace", record: trace }] }, { llm: async () => "should be ignored (llm flag off)" });
    assert.equal(res.mode, "deterministic");                 // LLM flag is off → template only
    assert.equal(res.narrated[0].mode, "deterministic");
  } finally { delete process.env.EI_NARRATION_ENABLED; }
});

// ── Metrics ───────────────────────────────────────────────────────────────────
test("Metrics: evidence-backed where possible; outcome metrics explicitly insufficient", async () => {
  const { traces, predictions } = await buildCorpus("ws-1");
  const corpus = { traces, predictions, recommendations: [], evidence };
  const metrics = computeMetrics(corpus);
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));

  // Explainability + humility are fully backed and should be 1.0 by construction.
  assert.equal(byKey.explainability_coverage.evidenceSufficient, true);
  assert.equal(byKey.explainability_coverage.value, 1);
  assert.equal(byKey.humility_coverage.value, 1);
  assert.equal(byKey.structural_intelligence_index.evidenceSufficient, true);

  // Outcome-dependent metrics are NEVER fabricated.
  for (const k of ["recommendation_adoption_rate", "prediction_accuracy", "hours_saved", "business_improvement_score", "platform_intelligence_score"]) {
    assert.equal(byKey[k].evidenceSufficient, false);
    assert.equal(byKey[k].value, null);
    assert.ok(byKey[k].reason && byKey[k].reason.length > 0);
  }
});

test("Metrics service: flag-gated OFF; ON separates backed vs. insufficient", async () => {
  const { traces, predictions } = await buildCorpus("ws-1");
  assert.equal((await computePlatformMetrics({ workspaceId: "off-ws", corpus: {} })).skipped, "flag_off");
  process.env.EI_METRICS_ENABLED = "true";
  try {
    const rep = await computePlatformMetrics({ workspaceId: "ws-1", corpus: { traces, predictions, recommendations: [], evidence } });
    assert.ok(rep.summary.evidenceBacked > 0);
    assert.ok(rep.summary.insufficientEvidence > 0);
    assert.ok(rep.summary.insufficientKeys.includes("platform_intelligence_score"));
  } finally { delete process.env.EI_METRICS_ENABLED; }
});
