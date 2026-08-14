import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDecisionLabRecommendation,
  calculateScenarioProjection,
  canonicalJson,
  normalizeDecisionInput,
  normalizeExperimentInput,
} from "../services/decisionOutcome.service.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

function commitment(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000111",
    owner_id: "00000000-0000-4000-8000-000000000222",
    title: "Launch the verified customer portal",
    success_measure: "Customers activate without support",
    primary_project_id: "00000000-0000-4000-8000-000000000333",
    progress: 45,
    assurance: {
      state: "at_risk",
      explanation: "Two connected tasks are blocked.",
      evidenceStatus: "observed",
      remainingDays: 8,
      taskProgress: 45,
      counts: {
        blockedTasks: 2,
        blockedDependencies: 0,
        overdueTasks: 0,
      },
    },
    ...overrides,
  };
}

test("a decision record requires the choice, rationale, expected review, and bounded confidence", () => {
  const value = normalizeDecisionInput({
    question: "Should we reduce launch scope?",
    selectedOption: "Keep activation and defer analytics",
    alternatives: ["Delay everything", "Keep activation and defer analytics", "Keep activation and defer analytics"],
    rationale: "Activation is the verified customer outcome; analytics is reversible.",
    expectedEffect: "Protect the target date without changing the success measure.",
    confidence: 72,
    reversibility: "partially_reversible",
  }, { reviewDays: 21, now: new Date("2026-08-14T00:00:00Z") });
  assert.equal(value.reviewDueAt, "2026-09-04");
  assert.equal(value.confidence, 72);
  assert.deepEqual(value.alternatives, ["Delay everything", "Keep activation and defer analytics"]);
  assert.throws(() => normalizeDecisionInput({ question: "Choose", selectedOption: "A" }), /rationale is required/i);
  assert.throws(() => normalizeDecisionInput({ question: "Choose", selectedOption: "A", rationale: "Because", confidence: 101 }), /between 0 and 100/);
  assert.throws(() => normalizeDecisionInput({ question: "Choose", selectedOption: "A", rationale: "Because", reviewDueAt: "2026-02-31" }), /date is not valid/i);
});

test("the decision lab returns one evidence-bounded action and a reversible experiment draft", () => {
  const recommendation = buildDecisionLabRecommendation(commitment(), { now: new Date("2026-08-14T00:00:00Z") });
  assert.equal(recommendation.action, "run_small_experiment");
  assert.equal(recommendation.experimentDraft.dueDate, "2026-08-16");
  assert.match(recommendation.guardrail, /One evidence-bounded next action/);
  assert.equal(Object.hasOwn(recommendation, "actions"), false);

  const insufficient = buildDecisionLabRecommendation(commitment({
    primary_project_id: null,
    assurance: {
      state: "insufficient_evidence",
      explanation: "Connect work before delivery status is inferred.",
      evidenceStatus: "insufficient_evidence",
      counts: {},
    },
  }));
  assert.equal(insufficient.action, "connect_work");
  assert.equal(insufficient.experimentDraft, null);
});

test("scenario comparison is directional, explainable, and never becomes a canonical score", () => {
  const result = calculateScenarioProjection(commitment(), {
    name: "Resolve the known blockers",
    resolveBlockedItems: 2,
    capacityDeltaPercent: 10,
    targetDateShiftDays: 0,
    scopeReductionPercent: 0,
    runValidationExperiment: true,
  }, { verifiedSampleSize: 4, requiredSampleSize: 3 });
  assert.equal(result.evidenceStatus, "modeled");
  assert.equal(result.direction, "improved");
  assert.equal(result.proposed.knownBlockers, 0);
  assert.equal(Object.hasOwn(result, "score"), false);
  assert.match(result.guardrail, /not a canonical workspace score/i);
  assert.ok(result.assumptions.length > 0);

  const unknown = calculateScenarioProjection(commitment({
    assurance: { state: "insufficient_evidence", evidenceStatus: "insufficient_evidence", counts: {} },
  }), { name: "Unobserved scenario" });
  assert.equal(unknown.direction, "unknown");
  assert.equal(unknown.confidenceLabel, "none");
});

test("experiment creation captures the smallest test and measurable information gain", () => {
  const value = normalizeExperimentInput({
    title: "Validate activation without support",
    hypothesis: "Five representative customers can activate without assistance.",
    smallestTest: "Run five observed production-like activations.",
    successMeasure: "At least four complete without intervention.",
    expectedInformation: "Whether onboarding is ready for the committed launch.",
    dueDate: "2026-08-20",
  }, { defaultOwnerId: "00000000-0000-4000-8000-000000000222" });
  assert.equal(value.ownerId, "00000000-0000-4000-8000-000000000222");
  assert.equal(value.dueDate, "2026-08-20");
});

test("experiment results become immutable and decision learning uses only the latest review", () => {
  const service = read("services/decisionOutcome.service.js");
  const collector = read("intelligence/engine/evidenceCollector.js");
  const memory = read("services/enterpriseAssurance.service.js");
  assert.match(service, /completed or cancelled experiment is an immutable historical record/i);
  assert.match(service, /WITH latest_reviews AS/);
  assert.match(collector, /WITH latest_decision_reviews AS/);
  const refreshMemory = memory.slice(memory.indexOf("export async function refreshAssuranceMemory"));
  assert.match(refreshMemory, /WITH latest_decision_reviews AS/);
  const portfolioLink = memory.slice(memory.indexOf("export async function setPortfolioCommitment"), memory.indexOf("export async function createAssuranceDependency"));
  assert.doesNotMatch(portfolioLink, /latest_decision_reviews/);
});

test("receipt canonicalization is replay-stable regardless of object key order", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { z: 1, y: [3, 2] } }),
    canonicalJson({ a: { y: [3, 2], z: 1 }, b: 2 })
  );
});

test("decision-to-outcome schema enforces tenant boundaries, evidence constraints, and RLS", () => {
  const sql = read("migrations/20260814_verified_decision_outcome_os.sql");
  for (const table of [
    "assurance_decisions",
    "assurance_decision_reviews",
    "assurance_experiments",
    "assurance_scenario_analyses",
    "assurance_policy_proposals",
    "assurance_outcome_receipts",
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /FOREIGN KEY \(workspace_id, goal_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, decision_id\)/);
  assert.match(sql, /assurance_decision_recorded_by_workspace_fkey/);
  assert.match(sql, /assurance_receipt_digest_check/);
  assert.match(sql, /confounded BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(sql, /require_decision_rationale BOOLEAN NOT NULL DEFAULT TRUE/);
});

test("only the existing user, manager, and admin role model is used across the new flow", () => {
  const routes = read("routes/assurance.routes.js");
  const service = read("services/decisionOutcome.service.js");
  assert.match(service, /new Set\(\["manager", "admin"\]\)/);
  assert.doesNotMatch(service, /executive_role|approver_role|owner_role/);
  for (const route of [
    "/commitments/:id/operating-record",
    "/commitments/:id/decision-lab",
    "/commitments/:id/decisions",
    "/decisions/:id/reviews",
    "/commitments/:id/experiments",
    "/commitments/:id/scenarios",
    "/commitments/:id/receipts",
    "/adaptive-policy-proposals",
  ]) assert.ok(routes.includes(route), `missing ${route}`);
  assert.match(routes, /decision-lab", allowRoles\("manager", "admin"\)/);
  assert.match(routes, /adaptive-policy-proposals", allowRoles\("admin"\)/);
  assert.match(service, /AND \$4::text!='user'/);
});

test("manager visibility is inherited from the existing outcome scope on every child record", () => {
  const service = read("services/decisionOutcome.service.js");
  assert.match(service, /getAssuranceCommitmentDetail/);
  assert.ok((service.match(/requireVisibleOutcome\(/g) || []).length >= 8);
  assert.match(service, /workspace_id=\$1 AND d\.id=\$2/);
  assert.match(service, /workspace_id=\$1 AND e\.id=\$2/);
  assert.match(service, /goal_id=ANY\(\$2::uuid\[\]\)/);
});

test("adaptive governance cannot silently apply observational learning", () => {
  const service = read("services/decisionOutcome.service.js");
  assert.match(service, /acknowledgeObservationalEvidence !== true/);
  assert.match(service, /role.*admin|assertAdmin/);
  assert.match(service, /status='applied'/);
  assert.match(service, /No proposal changes policy without|No autonomous policy|observational evidence/i);
});

test("decision evidence reaches executive summary v7 but never employee scoring", () => {
  const collector = read("intelligence/engine/evidenceCollector.js");
  const evaluator = read("intelligence/evaluators/workspaceEvaluator.js");
  const summary = read("intelligence/analytics/periodExecutiveSummary.service.js");
  assert.match(collector, /explicit_decision_count/);
  assert.match(collector, /completed_experiment_count/);
  assert.match(evaluator, /decisionOutcome:/);
  assert.match(evaluator, /scoreContribution: "none"/);
  assert.match(summary, /enterprise_executive_summary_v7/);
  assert.match(summary, /Decision-to-Outcome Intelligence/);
  assert.match(summary, /Decision activity does not increase employee or workspace scores/);
});

test("production deploy verifies the decision-to-outcome migration before image cutover", () => {
  const workflow = read(".github/workflows/deploy-selfhosted.yml");
  const migration = workflow.indexOf("20260814_verified_decision_outcome_os.sql");
  const verification = workflow.indexOf("verified decision-to-outcome migration verified");
  const imagePull = workflow.indexOf('echo "pulling $IMAGE_REF');
  assert.ok(migration >= 0 && verification > migration && imagePull > verification);
});
