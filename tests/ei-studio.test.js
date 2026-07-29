// tests/ei-studio.test.js
//
// Enterprise Intelligence Studio read-layer self-test. Hermetic + deterministic: stores
// are injected (no DB); the Studio only exposes the existing engines, so this verifies
// the assembly (mappers, corpus, search, relations) and that it delegates to real
// compute (validation/health/graph/executive) without duplicating logic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { searchIntelligence, traceRelations, rowToPrediction } from "../ei/studio/read.js";
import * as svc from "../ei/studio/service.js";
import { isEiStudioEnabled } from "../ei/config/flags.js";

const WS = "ws-s";
const traces = [{ traceId: "trace_1", workspaceId: WS, claim: { entity: { type: "Task", id: "t-1" }, predicate: "task.slipped", tier: "A", status: "attributed" }, confidenceDecomposition: { overall: 0.6 }, referencedEvidence: ["evd_1"], referencedAttribution: ["attr_1"], referencedGraphNodes: ["Task:t-1"], referencedEvents: ["e1"] }];
const predictions = [{ predictionId: "pred_1", workspaceId: WS, entity: { type: "Task", id: "t-1" }, predictionType: "risk:task.slipped", predictionValue: "likely", probability: 0.8, supportingReasoningTraceId: "trace_1", confidenceInterval: { low: 0.7, high: 0.9 }, unknownFactors: { illegibleDrivers: ["morale"] } }];
const recommendations = [{ recommendationId: "rec_1", workspaceId: WS, entity: { type: "Task", id: "t-1" }, recommendationType: "delivery_risk_mitigation", status: "recommended", manualOnly: false, uncertainty: {}, rationaleRefs: { predictionId: "pred_1", reasoningTraceId: "trace_1" } }];
const outcomes = [
  { outcomeId: "out_1", workspaceId: WS, kind: "prediction", status: "confirmed", refs: { predictionId: "pred_1" }, observedAt: "2026-07-05T00:00:00Z" },
  { outcomeId: "out_2", workspaceId: WS, kind: "recommendation", status: "executed", refs: { recommendationId: "rec_1" }, impact: { expected: 10, actual: 8 }, observedAt: "2026-07-06T00:00:00Z" },
];
const evidence = [{ evidenceId: "evd_1", workspaceId: WS, entity: { type: "Task", id: "t-1" } }];
const attributions = [{ attributionId: "attr_1", workspaceId: WS, ruleKey: "unassigned_slip", tier: "A" }];
const memory = [{ memoryId: "mem_1", workspaceId: WS, kind: "baseline", key: "prediction_accuracy" }];
const learning = [{ proposalId: "lp_1", workspaceId: WS, kind: "calibration_adoption", status: "candidate" }];
const experiments = [{ experimentId: "exp_1", workspaceId: WS, key: "h", design: "holdout" }];

const DEPS = {
  listCurrentEvidence: async () => evidence, listAttributions: async () => attributions, listTraces: async () => traces,
  listPredictions: async () => predictions, listRecommendations: async () => recommendations, listOutcomes: async () => outcomes,
  getCurrentCalibrationModel: async () => null, listProposals: async () => learning, listExperiments: async () => experiments,
  listCurrentMemory: async () => memory, listReviewDecisions: async () => [],
};

test("Studio flag defaults OFF", () => { assert.equal(isEiStudioEnabled(WS), false); });

test("read: search across every object type; deterministic", () => {
  const corpus = { evidence, attributions, traces, predictions, recommendations, outcomes, experiments, learning, memory };
  const r = searchIntelligence("pred_1", corpus);
  assert.ok(r.some((x) => x.type === "prediction" && x.id === "pred_1"));
  assert.ok(searchIntelligence("trace_1", corpus).some((x) => x.type === "trace"));
  assert.ok(searchIntelligence("risk:task", corpus).some((x) => x.type === "prediction")); // label match
  assert.equal(searchIntelligence("", corpus).length, 0);
});

test("read: trace relations link predictions + recommendations", () => {
  const rel = traceRelations(traces[0], { predictions, recommendations });
  assert.deepEqual(rel.predictions, ["pred_1"]);
  assert.deepEqual(rel.recommendations, ["rec_1"]);
  assert.deepEqual(rel.referencedEvidence, ["evd_1"]);
});

test("read: rowToPrediction maps a DB row to a rich object", () => {
  const p = rowToPrediction({ prediction_id: "pred_9", workspace_id: WS, entity_json: JSON.stringify({ type: "Task", id: "z" }), prediction_type: "risk:x", probability: 0.5, confidence_low: 0.4, confidence_high: 0.6, reasoning_trace_id: "trace_9", unknown_factors_json: "{}" });
  assert.equal(p.predictionId, "pred_9");
  assert.equal(p.entity.id, "z");
  assert.equal(p.supportingReasoningTraceId, "trace_9");
});

test("service: corpus + delegates to real engines (validation/health/graph/executive)", async () => {
  const c = await svc.buildCorpus({ workspaceId: WS }, DEPS);
  assert.equal(c.traces.length, 1);
  assert.equal(c.predictions.length, 1);

  const v = await svc.getValidation({ workspaceId: WS }, DEPS);
  assert.equal(v.metrics.accuracy.value, 1); // 1 confirmed, predicted likely → correct

  const h = await svc.getHealth({ workspaceId: WS }, DEPS);
  const rq = h.find((m) => m.key === "reasoning_quality");
  assert.equal(rq.value, 1); // prediction resolves to its trace

  const g = await svc.getGraph({ workspaceId: WS }, DEPS);
  assert.ok(g.edges.some((e) => e.rel === "predicts") && g.edges.some((e) => e.rel === "recommends"));

  const ex = await svc.getExecutive({ workspaceId: WS }, DEPS);
  assert.equal(ex.answers.length, 6);

  const s = await svc.search({ workspaceId: WS, q: "rec_1" }, DEPS);
  assert.ok(s.results.some((x) => x.type === "recommendation"));

  const td = await svc.getTraceDetail({ workspaceId: WS, traceId: "trace_1" }, DEPS);
  assert.deepEqual(td.relations.predictions, ["pred_1"]);
  assert.deepEqual(td.relations.recommendations, ["rec_1"]);

  const pd = await svc.getPredictionDetail({ workspaceId: WS, predictionId: "pred_1" }, DEPS);
  assert.equal(pd.trace.traceId, "trace_1");
  assert.equal(pd.outcomes.length, 1);
});
