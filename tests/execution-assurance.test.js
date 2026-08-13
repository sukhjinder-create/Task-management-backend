import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildAssuranceAttention,
  calculateAssuranceState,
  canManageAssurance,
  deriveTimePeriod,
  getAssuranceOverview,
  normalizeAssuranceInput,
} from "../services/executionAssurance.service.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = new Date("2026-08-13T10:00:00.000Z");

function row(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Launch the customer portal",
    status: "on_track",
    progress: 0,
    target_date: "2026-10-31",
    task_count: 0,
    completed_task_count: 0,
    overdue_task_count: 0,
    blocked_task_count: 0,
    linked_sprint_count: 0,
    evidence_count: 0,
    result_evidence_count: 0,
    governed_action_count: 0,
    pending_decision_count: 0,
    ...overrides,
  };
}

test("outcome creation stays a four-question contract with safe defaults", () => {
  const value = normalizeAssuranceInput({
    outcome: "  Launch the customer portal  ",
    successMeasure: "Customers can activate without support",
    targetDate: "2026-10-31",
    ownerId: "22222222-2222-4222-8222-222222222222",
  });

  assert.equal(value.outcome, "Launch the customer portal");
  assert.equal(value.successMeasure, "Customers can activate without support");
  assert.equal(value.targetDate, "2026-10-31");
  assert.equal(value.priority, "high");
  assert.deepEqual(value.evidenceRequirements, []);
  assert.equal(deriveTimePeriod(value.targetDate), "Q4 2026");
  assert.throws(() => normalizeAssuranceInput({ outcome: "X", targetDate: "2026-10-31" }), /Success measure is required/);
  assert.throws(() => normalizeAssuranceInput({
    outcome: "X",
    successMeasure: "Y",
    targetDate: "2026-10-31",
    ownerId: "another-workspace-user",
  }), /Owner is not valid/);
});

test("an empty workspace never receives an invented health state", () => {
  const assurance = calculateAssuranceState(row(), NOW);
  assert.equal(assurance.state, "insufficient_evidence");
  assert.equal(assurance.evidenceStatus, "insufficient_evidence");
  assert.equal(assurance.taskProgress, null);
  assert.match(assurance.explanation, /Connect a project or record evidence/);
});

test("empty workspace overview returns zeros without querying another tenant", async () => {
  const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let calls = 0;
  const database = {
    async query(sql, values) {
      calls += 1;
      assert.deepEqual(values, [workspaceId, userId]);
      assert.match(sql, /o\.workspace_id = \$1/);
      assert.match(sql, /o\.owner_id = \$2/);
      return { rows: [] };
    },
  };

  const overview = await getAssuranceOverview({
    workspaceId,
    userId,
    role: "user",
    database,
    now: NOW,
  });

  assert.equal(calls, 1);
  assert.deepEqual(overview.summary, {
    total: 0,
    needsAttention: 0,
    verified: 0,
    pendingDecisions: 0,
  });
  assert.deepEqual(overview.commitments, []);
  assert.deepEqual(overview.attention, []);
  assert.deepEqual(overview.options, { owners: [], projects: [] });
});

test("delivery exceptions are commitment-level and evidence based", () => {
  const blocked = calculateAssuranceState(row({
    task_count: 5,
    completed_task_count: 2,
    blocked_task_count: 1,
  }), NOW);
  assert.equal(blocked.state, "at_risk");
  assert.match(blocked.explanation, /1 connected task is blocked/);

  const overdue = calculateAssuranceState(row({
    task_count: 3,
    completed_task_count: 1,
    overdue_task_count: 2,
  }), NOW);
  assert.equal(overdue.state, "off_track");
  assert.match(overdue.explanation, /2 connected tasks are overdue/);
});

test("completion is verified only when result evidence exists", () => {
  assert.equal(calculateAssuranceState(row({ status: "done", progress: 100 }), NOW).state, "needs_evidence");
  assert.equal(calculateAssuranceState(row({
    status: "done",
    progress: 100,
    evidence_count: 1,
    result_evidence_count: 1,
  }), NOW).state, "verified");
});

test("attention exposes one plain next action instead of internal platform concepts", () => {
  const commitment = {
    ...row({ primary_project_id: "project-1", task_count: 2, overdue_task_count: 1 }),
  };
  commitment.assurance = calculateAssuranceState(commitment, NOW);
  const attention = buildAssuranceAttention(commitment);

  assert.equal(attention.action, "create_recovery_task");
  assert.equal(attention.actionLabel, "Create recovery task");
  assert.equal(Object.prototype.hasOwnProperty.call(attention, "score"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attention, "confidence"), false);
});

test("role policy is explicit and does not grant ordinary members write authority", () => {
  assert.equal(canManageAssurance("admin"), true);
  assert.equal(canManageAssurance("owner"), true);
  assert.equal(canManageAssurance("manager"), true);
  assert.equal(canManageAssurance("user"), false);
  assert.equal(canManageAssurance("superadmin"), false);
});

test("assurance storage and queries preserve tenant and provenance boundaries", () => {
  const migration = read("migrations/20260813b_execution_assurance.sql");
  const service = read("services/executionAssurance.service.js");
  const index = read("index.js");

  assert.match(migration, /workspace_id UUID NOT NULL REFERENCES public\.workspaces\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /FOREIGN KEY \(workspace_id, goal_id\)[\s\S]*REFERENCES public\.okr_objectives\(workspace_id, id\) ON DELETE CASCADE/i);
  assert.match(migration, /FOREIGN KEY \(workspace_id, primary_project_id\)/i);
  assert.match(migration, /ALTER TABLE public\.goal_assurance_evidence ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS goal_id UUID/i);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.match(service, /WHERE gae\.workspace_id = o\.workspace_id AND gae\.goal_id = o\.id/);
  assert.match(service, /WHERE oaa\.workspace_id = o\.workspace_id AND oaa\.goal_id = o\.id/);
  assert.match(service, /o\.success_measure IS NOT NULL/);
  assert.match(service, /WHERE id = \$1 AND workspace_id = \$2/);
  assert.match(service, /u\.workspace_id = \$1/);
  assert.match(index, /app\.use\("\/assurance",\s+authMiddleware,\s+requireWorkspaceForUser,\s+requirePlanFeature\("okr_goals"\),\s+assuranceRoutes\)/);
});

test("governed recovery actions reuse the existing approval and execution trail", () => {
  const service = read("services/executionAssurance.service.js");
  const operations = read("services/operationsAction.service.js");

  assert.match(service, /source: "assurance"/);
  assert.match(service, /approvalMode: "approval_required"/);
  assert.match(service, /approveOperationsAction\(\{/);
  assert.match(service, /execute: true/);
  assert.match(operations, /goal_id,/);
  assert.match(operations, /g\.workspace_id = a\.workspace_id/);
  assert.match(operations, /u\.workspace_id = a\.workspace_id/);
  assert.match(operations, /p\.workspace_id = a\.workspace_id/);
  assert.match(operations, /t\.workspace_id = a\.workspace_id/);
});

test("production deploy applies and verifies the additive schema before image cutover", () => {
  const workflow = read(".github/workflows/deploy-selfhosted.yml");
  const migrationPosition = workflow.indexOf('ASSURANCE_MIGRATION="migrations/20260813b_execution_assurance.sql"');
  const imageCutoverPosition = workflow.indexOf('echo "pulling $IMAGE_REF ..."');

  assert.ok(migrationPosition >= 0, "production workflow must apply the assurance migration");
  assert.ok(imageCutoverPosition > migrationPosition, "schema must be ready before the new image is pulled");
  assert.match(workflow, /execution assurance migration verified/);
  assert.match(workflow, /migration failed; current image remains active/);
});
