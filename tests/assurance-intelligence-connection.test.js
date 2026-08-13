import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateWorkspaceIntelligence } from "../intelligence/evaluators/workspaceEvaluator.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const baseEvidence = {
  execution: {
    internalTotal: 10,
    internalCompleted: 6,
    externalTotal: 0,
    externalCompleted: 0,
    totalWork: 10,
    completedWork: 6,
  },
};

test("outcome assurance cannot affect canonical workspace scoring before the verified evidence gate", () => {
  const withoutAssurance = evaluateWorkspaceIntelligence({
    workspaceId: "workspace-1",
    evidence: baseEvidence,
  });
  const learning = evaluateWorkspaceIntelligence({
    workspaceId: "workspace-1",
    evidence: {
      ...baseEvidence,
      assurance: {
        eligible: false,
        requiredSampleSize: 3,
        verifiedSampleSize: 2,
        verifiedOnTimeCount: 0,
        outcomeCount: 3,
        outcomesWithEvidence: 1,
        snapshottedOutcomeCount: 3,
        healthyOutcomeCount: 0,
      },
    },
  });

  assert.equal(learning.score, withoutAssurance.score);
  assert.deepEqual(learning.indexes, withoutAssurance.indexes);
  assert.equal(learning.analytics.assurance.status, "learning");
  assert.equal(learning.analytics.assurance.outcomeAssuranceIndex, null);
  assert.deepEqual(learning.analytics.assurance.contributionPaths, []);
  assert.equal(learning.analytics.assurance.finalScoreImpactPoints, 0);
});

test("eligible verified outcomes contribute through the two declared canonical indexes with an auditable counterfactual", () => {
  const result = evaluateWorkspaceIntelligence({
    workspaceId: "workspace-1",
    evidence: {
      ...baseEvidence,
      assurance: {
        eligible: true,
        requiredSampleSize: 3,
        verifiedSampleSize: 4,
        verifiedOnTimeCount: 4,
        outcomeCount: 4,
        outcomesWithEvidence: 4,
        snapshottedOutcomeCount: 4,
        healthyOutcomeCount: 4,
        attentionOutcomeCount: 0,
      },
    },
  });
  const assurance = result.analytics.assurance;

  assert.equal(assurance.status, "contributing");
  assert.deepEqual(assurance.contributionPaths, ["executionRealityIndex", "deliveryConfidenceIndex"]);
  assert.ok(assurance.outcomeAssuranceIndex >= 75);
  assert.equal(assurance.verifiedOnTimeRate, 100);
  assert.equal(assurance.evidenceCoverageRate, 100);
  assert.equal(assurance.currentHealthyRate, 100);
  assert.equal(result.score - assurance.scoreWithoutOutcomeAssurance, assurance.finalScoreImpactPoints);
  assert.ok(assurance.indexImpactPoints.executionRealityIndex > 0);
  assert.ok(assurance.indexImpactPoints.deliveryConfidenceIndex > 0);
});

test("assurance evidence, executive narrative, explanation, and refresh paths remain tenant-scoped and interconnected", () => {
  const collector = read("intelligence/engine/evidenceCollector.js");
  const summary = read("intelligence/analytics/periodExecutiveSummary.service.js");
  const explanation = read("intelligence/analytics/intelligenceResponses.service.js");
  const assurance = read("services/enterpriseAssurance.service.js");

  assert.match(collector, /assurance_outcome_observations observation[\s\S]*observation\.workspace_id = \$1/);
  assert.match(collector, /goal_assurance_evidence e[\s\S]*e\.workspace_id = \$1/);
  assert.match(summary, /enterprise_executive_summary_v6/);
  assert.match(summary, /section\("outcomeAssurance", "Outcome Assurance"/);
  assert.match(summary, /verified evidence contributes to Execution Reality and Delivery Confidence/);
  assert.match(explanation, /outcomeAssuranceEffect/);
  assert.match(explanation, /indirect_via_execution_reality_and_delivery_confidence/);
  assert.match(assurance, /reason: "outcome_assurance_changed"/);
  assert.match(assurance, /queueImpactedIntelligenceRecalculation/);
});
