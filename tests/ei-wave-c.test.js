// tests/ei-wave-c.test.js
//
// EI V2.1 Wave C self-test: the closed loop — Outcomes Ledger, Recommendation
// Effectiveness, Prediction Validation, Calibration, Experiments, Organizational
// Memory, Learning (proposals only) + Governance, and Platform Health. Hermetic +
// deterministic (fixed fixtures; DI stores; no DB, no LLM). Stores UNVERIFIED AT
// RUNTIME.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createOutcome, validateOutcome } from "../ei/outcomes/outcome.js";
import { recordOutcomes } from "../ei/outcomes/service.js";
import { computeEffectiveness } from "../ei/effectiveness/effectiveness.js";
import { validatePredictionOutcomes } from "../ei/validation/validation.js";
import { buildCalibrationModel, applyCalibration, isotonic } from "../ei/calibration/calibration.js";
import { buildWorkspaceCalibration } from "../ei/calibration/service.js";
import { createExperiment, validateExperiment, assign } from "../ei/experiments/experiment.js";
import { defineExperiment, assignSubjects } from "../ei/experiments/service.js";
import { deriveMemories } from "../ei/memory/memory.js";
import { deriveOrganizationalMemory } from "../ei/memory/service.js";
import { generateProposals } from "../ei/learning/engine.js";
import { validateLearningProposal } from "../ei/learning/proposal.js";
import { resolveProposalState, buildReviewQueue } from "../ei/learning/governance.js";
import { proposeLearning, reviewLearningProposal } from "../ei/learning/service.js";
import { buildGraph } from "../ei/graph/graph.js";
import { computeHealth } from "../ei/health/health.js";
import { computePlatformHealth } from "../ei/health/service.js";

const WS = "ws-c";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const T = (id, ent, gnodes) => ({ traceId: id, workspaceId: WS, claim: { entity: ent, predicate: "task.slipped", tier: "A", status: "attributed" }, confidenceDecomposition: { overall: 0.6 }, referencedGraphNodes: gnodes, referencedAttribution: ["attr_" + id], referencedEvidence: ["evd_" + id], reasoningChain: [{ from: { descriptor: "unassigned_owner" }, tier: "A" }], alternativeHypotheses: [], observedUncertainty: { observedCoverage: 0.6 }, unknownFactors: { illegibleDrivers: ["morale"] } });
const t1 = T("trace_1", { type: "Task", id: "t-1" }, ["Task:t-1"]);
const t2 = T("trace_2", { type: "Task", id: "t-2" }, ["Task:t-2"]);
const traces = [t1, t2];

const P = (id, prob, traceId, ent) => ({ predictionId: id, workspaceId: WS, entity: ent, predictionType: "risk:task.slipped", predictionValue: prob >= 0.5 ? "likely" : "unlikely", probability: prob, confidenceInterval: { low: Math.max(0, prob - 0.1), high: Math.min(0.99, prob + 0.1) }, predictionHorizon: { days: 14 }, supportingReasoningTraceId: traceId, alternativeOutcomes: [], assumptions: [], observedUncertainty: {}, unknownFactors: { illegibleDrivers: ["morale"] } });
const predictions = [
  P("p1", 0.9, "trace_1", { type: "Task", id: "t-1" }),
  P("p2", 0.8, "trace_1", { type: "Task", id: "t-1" }),
  P("p3", 0.2, "trace_2", { type: "Task", id: "t-2" }),
  P("p4", 0.7, "trace_2", { type: "Task", id: "t-2" }),
  P("p5", 0.4, "trace_1", { type: "Task", id: "t-1" }),
];

const R = (id, predId, traceId) => ({ recommendationId: id, workspaceId: WS, recommendationType: "delivery_risk_mitigation", entity: { type: "Task", id: "t-1" }, status: "recommended", manualOnly: false, rationaleRefs: { predictionId: predId, reasoningTraceId: traceId, evidenceIds: [], attributionIds: [] } });
const recommendations = [R("r1", "p2", "trace_1"), R("r2", "p5", "trace_1"), R("r3", "p1", "trace_1")];

const OP = (predId, status) => createOutcome({ workspaceId: WS, kind: "prediction", status, refs: { predictionId: predId }, observedAt: "2026-07-05T00:00:00Z" });
const OR = (recId, status, impact = null) => createOutcome({ workspaceId: WS, kind: "recommendation", status, refs: { recommendationId: recId }, observedAt: "2026-07-06T00:00:00Z", impact });
const predOutcomes = [OP("p1", "confirmed"), OP("p2", "refuted"), OP("p3", "refuted"), OP("p4", "confirmed"), OP("p5", "confirmed")];
const recOutcomes = [OR("r1", "executed", { expected: 10, actual: 6 }), OR("r2", "executed", { expected: 8, actual: 5 }), OR("r3", "accepted")];
const allOutcomes = [...predOutcomes, ...recOutcomes];

const validation = validatePredictionOutcomes({ predictions, outcomes: predOutcomes });
const effectiveness = computeEffectiveness({ recommendations, outcomes: recOutcomes, dimension: "type" });

// ── 1. Outcomes Ledger ────────────────────────────────────────────────────────
test("Outcomes: immutable, references subject, deterministic, validated, append-only", async () => {
  const o = OP("p1", "confirmed");
  assert.ok(o.outcomeId.startsWith("out_"));
  assert.equal(o.subjectId, "p1");
  assert.equal(o.kind, "prediction");
  assert.ok(Object.isFrozen(o));
  assert.equal(validateOutcome(o).ok, true);
  assert.equal(OP("p1", "confirmed").outcomeId, o.outcomeId); // deterministic
  assert.equal(createOutcome({ workspaceId: WS, kind: "prediction", status: "bogus", refs: { predictionId: "p1" }, observedAt: "2026-07-05T00:00:00Z" }), null); // invalid status rejected

  assert.equal((await recordOutcomes({ workspaceId: "off", observations: [] })).skipped, "flag_off");
  process.env.EI_OUTCOMES_ENABLED = "true";
  try {
    const written = [];
    const r = await recordOutcomes({ workspaceId: WS, observations: [{ kind: "prediction", status: "confirmed", refs: { predictionId: "p1" }, observedAt: "2026-07-05T00:00:00Z" }] }, { appendOutcome: async (x) => (written.push(x.outcomeId), x.outcomeId) });
    assert.equal(r.recorded, 1);
    assert.equal(written.length, 1);
  } finally { delete process.env.EI_OUTCOMES_ENABLED; }
});

// ── 2. Recommendation Effectiveness ───────────────────────────────────────────
test("Effectiveness: acceptance/execution/completion + impact; timestamps insufficient", () => {
  const g = effectiveness.groups.find((x) => x.key === "delivery_risk_mitigation");
  assert.equal(g.metrics.acceptanceRate.value, 1);
  assert.equal(g.metrics.executionRate.value, 0.6667);
  assert.equal(g.metrics.completionRate.value, 1);
  assert.equal(g.metrics.effectiveness.value, 0.6111);      // 5.5 / 9
  assert.equal(g.metrics.timeToActionHours.evidenceSufficient, false); // no creation timestamps
});

// ── 3. Prediction Validation ──────────────────────────────────────────────────
test("Validation: precision/recall/accuracy/Brier + calibration buckets (deterministic)", () => {
  assert.equal(validation.metrics.accuracy.value, 0.6);
  assert.equal(validation.metrics.precision.value, 0.666667);
  assert.equal(validation.metrics.recall.value, 0.666667);
  assert.equal(validation.metrics.brierScore.value, 0.228);
  assert.equal(validation.metrics.falsePositives.value, 1);
  assert.equal(validation.metrics.falseNegatives.value, 1);
  assert.equal(validation.metrics.calibrationQuality.value, 0.6);
  assert.equal(validation.calibration.length, 5);
  // Unknown handling: an extra prediction with no outcome is classified unknown.
  const withUnknown = validatePredictionOutcomes({ predictions: [...predictions, P("p6", 0.6, "trace_1", { type: "Task", id: "t-9" })], outcomes: predOutcomes });
  assert.equal(withUnknown.counts.unknown, 1);
});

// ── 4. Calibration Engine ─────────────────────────────────────────────────────
test("Calibration: isotonic monotone, versioned (never overwrite), deterministic apply", async () => {
  const iso = isotonic([1, 0, 0.5, 1], [1, 1, 1, 1]);
  assert.equal(iso.length, 4);
  for (let i = 1; i < iso.length; i++) assert.ok(iso[i] >= iso[i - 1]); // non-decreasing

  const m1 = buildCalibrationModel({ workspaceId: WS, calibration: validation.calibration });
  assert.equal(m1.version, 1);
  assert.ok(m1.buckets.length >= 1);
  const applied = applyCalibration(0.85, m1);
  assert.ok(applied.calibrated >= 0 && applied.calibrated <= 1);
  assert.deepEqual(applyCalibration(0.85, m1), applied); // deterministic

  const m2 = buildCalibrationModel({ workspaceId: WS, calibration: validation.calibration, priorModel: m1 });
  assert.equal(m2.version, 2);
  assert.notEqual(m2.calibrationId, m1.calibrationId);          // new version, history preserved
  assert.equal(m2.supersedes.calibrationId, m1.calibrationId);

  assert.equal((await buildWorkspaceCalibration({ workspaceId: "off", validation })).skipped, "flag_off");
  process.env.EI_CALIBRATION_ENABLED = "true";
  try {
    const written = [];
    const r = await buildWorkspaceCalibration({ workspaceId: WS, validation }, { appendCalibrationModel: async (x) => (written.push(x.calibrationId), x.calibrationId) });
    assert.equal(r.built, true);
    assert.equal(written.length, 1);
  } finally { delete process.env.EI_CALIBRATION_ENABLED; }
});

// ── 5. Experiment Engine ──────────────────────────────────────────────────────
test("Experiments: declared arms, holdout needs control, deterministic assignment", async () => {
  const good = createExperiment({ workspaceId: WS, key: "rec_policy", design: "holdout", arms: [{ key: "control", allocation: 0.5, control: true }, { key: "treatment", allocation: 0.5 }], references: { recommendationIds: ["r1"] } });
  assert.equal(validateExperiment(good).ok, true);
  const noControl = createExperiment({ workspaceId: WS, key: "x", design: "holdout", arms: [{ key: "a", allocation: 0.5 }, { key: "b", allocation: 0.5 }] });
  assert.deepEqual(validateExperiment(noControl).errors.includes("holdout_requires_control_arm"), true);

  const a1 = assign("subject-1", good);
  assert.deepEqual(assign("subject-1", good), a1);   // deterministic
  assert.ok(["control", "treatment"].includes(a1.arm));
  assert.equal(assign("s", createExperiment({ workspaceId: WS, key: "m", design: "manual", arms: [{ key: "only", allocation: 1 }] })).arm, null);

  assert.equal((await defineExperiment({ workspaceId: "off" })).skipped, "flag_off");
  process.env.EI_EXPERIMENTS_ENABLED = "true";
  try {
    const def = await defineExperiment({ workspaceId: WS, key: "rec_policy", design: "holdout", arms: [{ key: "control", allocation: 0.5, control: true }, { key: "treatment", allocation: 0.5 }] }, { appendExperiment: async () => "x" });
    assert.equal(def.defined, true);
    const asg = await assignSubjects({ workspaceId: WS, experiment: def.experiment, subjectIds: ["s1", "s2"] }, { appendAssignment: async () => "y" });
    assert.equal(asg.assigned, 2);
  } finally { delete process.env.EI_EXPERIMENTS_ENABLED; }
});

// ── 6. Organizational Memory ──────────────────────────────────────────────────
test("Memory: derived from validated records, versioned, deterministic", async () => {
  const mems = deriveMemories({ workspaceId: WS, predictions, outcomes: allOutcomes, validation, effectiveness });
  assert.ok(mems.some((m) => m.kind === "repeated_failure"));        // 2 refuted of same type
  assert.ok(mems.some((m) => m.kind === "baseline"));
  assert.ok(mems.some((m) => m.kind === "historical_distribution"));
  assert.ok(mems.every((m) => m.version === 1 && m.revisionKey));
  assert.deepEqual(deriveMemories({ workspaceId: WS, predictions, outcomes: allOutcomes, validation, effectiveness }), mems); // deterministic

  process.env.EI_MEMORY_ENABLED = "true";
  try {
    const written = [];
    const r = await deriveOrganizationalMemory({ workspaceId: WS, predictions, outcomes: allOutcomes, validation, effectiveness }, { appendMemory: async (m) => (written.push(m.memoryId), m.memoryId) });
    assert.ok(r.derived >= 3);
    assert.equal(written.length, r.derived);
  } finally { delete process.env.EI_MEMORY_ENABLED; }
});

// ── 7. Learning Engine + Governance ───────────────────────────────────────────
test("Learning: proposals only from verified outcomes; confounding needs holdout", async () => {
  const holdout = createExperiment({ workspaceId: WS, key: "h", design: "holdout", arms: [{ key: "control", allocation: 0.5, control: true }, { key: "treatment", allocation: 0.5 }] });

  // With a holdout, confounded calibration learning is admissible.
  const withHoldout = generateProposals({ workspaceId: WS, recommendations, predictions, outcomes: allOutcomes, validation, effectiveness, experiments: [holdout] });
  const cal = withHoldout.find((p) => p.kind === "calibration_adoption");
  assert.ok(cal && cal.cleanliness.confounded === true && cal.evidence.holdout === true && cal.admissible === true);
  assert.equal(validateLearningProposal(cal).ok, true);
  assert.ok(cal.rationaleRefs.outcomeIds.length > 0); // learns only from outcomes
  assert.ok(Object.isFrozen(cal));                    // no mutation surface

  // Without a holdout, the same confounded proposal is BLOCKED (constitutional guard).
  const noHoldout = generateProposals({ workspaceId: WS, recommendations, predictions, outcomes: allOutcomes, validation, effectiveness, experiments: [] });
  const calBlocked = noHoldout.find((p) => p.kind === "calibration_adoption");
  assert.equal(calBlocked.admissible, false);
  assert.equal(calBlocked.status, "blocked_confounded");
  assert.deepEqual(validateLearningProposal(calBlocked).errors.includes("confounded_evidence_requires_holdout"), true);

  // Governance: approval marks READY, not applied; nothing auto-publishes.
  const catalog = noHoldout.find((p) => p.kind === "catalog_min_probability");
  assert.ok(catalog && catalog.admissible === true);
  const pending = resolveProposalState(catalog, []);
  assert.equal(pending.reviewState, "pending");
  const decision = { proposalId: catalog.proposalId, decision: "approved", decidedAt: "2026-07-07T00:00:00Z", decisionId: "d1" };
  const state = resolveProposalState(catalog, [decision]);
  assert.equal(state.reviewState, "approved");
  assert.equal(state.applied, false);                 // not applied — application is a separate step
  assert.equal(buildReviewQueue([catalog], [decision]).length, 0); // leaves the queue once decided

  // Service gating + flow.
  assert.equal((await proposeLearning({ workspaceId: "off" })).skipped, "flag_off");
  process.env.EI_LEARNING_ENABLED = "true";
  try {
    const res = await proposeLearning({ workspaceId: WS, recommendations, predictions, outcomes: allOutcomes, validation, effectiveness, experiments: [holdout] }, { appendProposal: async () => "p" });
    assert.ok(res.proposed >= 2 && res.admissible >= 1);
    const rev = await reviewLearningProposal({ workspaceId: WS, proposal: catalog, decision: "approved", decidedAt: "2026-07-07T00:00:00Z" }, { appendReviewDecision: async () => "d" });
    assert.equal(rev.reviewed, true);
    assert.equal(rev.state.applied, false);
  } finally { delete process.env.EI_LEARNING_ENABLED; }
});

// ── 8. Platform Health ────────────────────────────────────────────────────────
test("Health: evidence-backed qualities + maturity; insufficient where no data", async () => {
  const graph = buildGraph({ workspaceId: WS, traces, predictions, recommendations });
  const calibrationModel = buildCalibrationModel({ workspaceId: WS, calibration: validation.calibration });
  const memory = deriveMemories({ workspaceId: WS, predictions, outcomes: allOutcomes, validation, effectiveness });
  const experiments = [createExperiment({ workspaceId: WS, key: "h", design: "holdout", arms: [{ key: "control", allocation: 0.5, control: true }, { key: "treatment", allocation: 0.5 }] })];
  const proposals = generateProposals({ workspaceId: WS, recommendations, predictions, outcomes: allOutcomes, validation, effectiveness, experiments });

  const corpus = { traces, predictions, recommendations, evidence: [], outcomes: allOutcomes, validation, effectiveness, calibrationModel, memory, graph, experiments, proposals };
  const m = Object.fromEntries(computeHealth(corpus).map((x) => [x.key, x]));
  assert.equal(m.reasoning_quality.value, 1);
  assert.equal(m.prediction_quality.value, 0.6);
  assert.equal(m.recommendation_quality.value, 0.6111);
  assert.equal(m.unknown_rate.value, 0);
  assert.equal(m.graph_completeness.value, 0.6);
  assert.equal(m.organizational_learning_maturity.value.stage, 4);

  // Empty corpus → qualities are insufficient, never fabricated.
  const empty = Object.fromEntries(computeHealth({ predictions: [], traces: [] }).map((x) => [x.key, x]));
  assert.equal(empty.prediction_quality.evidenceSufficient, false);

  process.env.EI_HEALTH_ENABLED = "true";
  try {
    const rep = await computePlatformHealth({ workspaceId: WS, corpus });
    assert.ok(rep.summary.evidenceBacked > 0);
  } finally { delete process.env.EI_HEALTH_ENABLED; }
  assert.equal((await computePlatformHealth({ workspaceId: "off", corpus })).skipped, "flag_off");
});
