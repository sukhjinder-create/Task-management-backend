import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ASSURANCE_POLICY,
  ingestExternalAssuranceEvidence,
  normalizeAssurancePolicy,
  refreshAssuranceMemory,
} from "../services/enterpriseAssurance.service.js";
import { calculateAssuranceState } from "../services/executionAssurance.service.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("workspace policy is bounded and preserves a non-empty approval authority", () => {
  const normalized = normalizeAssurancePolicy({
    riskWindowDays: 21,
    minimumPatternSample: 5,
    approvalMatrix: {
      complete: { requestRoles: ["user"], approveRoles: ["manager", "not-a-role"] },
      recovery: { requestRoles: ["user", "manager"], approveRoles: [] },
      evidence: { writeRoles: ["user"] },
    },
  });
  assert.equal(normalized.riskWindowDays, 21);
  assert.equal(normalized.minimumPatternSample, 5);
  assert.deepEqual(normalized.approvalMatrix.complete.approveRoles, ["manager"]);
  assert.deepEqual(normalized.approvalMatrix.complete.requestRoles, ["user"]);
  assert.deepEqual(normalized.approvalMatrix.recovery.requestRoles, ["manager"]);
  assert.deepEqual(
    normalized.approvalMatrix.recovery.approveRoles,
    DEFAULT_ASSURANCE_POLICY.approvalMatrix.recovery.approveRoles
  );
  assert.throws(() => normalizeAssurancePolicy({ minimumPatternSample: 2 }), /between 3 and 100/);
  assert.throws(() => normalizeAssurancePolicy({ automaticExternalEvidence: "false" }), /must be true or false/);
  assert.deepEqual(DEFAULT_ASSURANCE_POLICY.approvalMatrix.complete.requestRoles, ["user", "manager", "admin"]);
  assert.deepEqual(DEFAULT_ASSURANCE_POLICY.approvalMatrix.complete.approveRoles, ["manager", "admin"]);
  assert.deepEqual(DEFAULT_ASSURANCE_POLICY.approvalMatrix.evidence.writeRoles, ["user", "manager", "admin"]);
});

test("dependency evidence changes state without inventing a health score", () => {
  const result = calculateAssuranceState({
    status: "on_track",
    progress: 60,
    target_date: "2026-12-31",
    task_count: 2,
    completed_task_count: 1,
    blocked_dependency_count: 1,
    evidence_count: 1,
  }, new Date("2026-08-13T00:00:00Z"), { riskWindowDays: 7 });
  assert.equal(result.state, "at_risk");
  assert.match(result.explanation, /predecessor outcome/);
  assert.equal(Object.hasOwn(result, "score"), false);
});

test("external evidence ingestion is idempotent and preserves provider provenance", async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ id: "evidence-1", goal_id: "goal-1", source_provider: "asana" }] };
    },
  };
  const result = await ingestExternalAssuranceEvidence({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    database,
    now: new Date("2026-08-13T10:00:00Z"),
  });
  assert.equal(result.captured, 1);
  assert.match(calls[0].sql, /integration_task_mappings/);
  assert.match(calls[0].sql, /ON CONFLICT \(workspace_id, idempotency_key\)/);
  assert.match(calls[0].sql, /source_provider/);
  assert.equal(calls[0].values[0], "00000000-0000-4000-8000-000000000001");
});

test("organizational memory stays empty before the verified evidence threshold", async () => {
  const database = {
    async query(sql) {
      assert.match(sql, /assurance_outcome_observations/);
      return { rows: [{ sample_size: 2, observation_ids: [] }] };
    },
  };
  const result = await refreshAssuranceMemory({
    workspaceId: "workspace-1",
    database,
    policy: { ...DEFAULT_ASSURANCE_POLICY, minimumPatternSample: 3 },
  });
  assert.deepEqual(result, { status: "learning", sampleSize: 2, requiredSampleSize: 3, patterns: [] });
});

test("organizational memory publishes only measured, non-causal patterns", async () => {
  const calls = [];
  const database = {
    async query(sql) {
      calls.push(sql);
      if (/SELECT\s+COUNT\(\*\)::int AS sample_size/.test(sql)) {
        return { rows: [{ sample_size: 4, on_time_count: 3, recovery_sample_size: 3, recovery_on_time_count: 2, average_days_to_verify: "18.5", observation_ids: ["o1", "o2", "o3", "o4"] }] };
      }
      if (/SELECT \* FROM assurance_memory_patterns/.test(sql)) {
        return { rows: [{ pattern_key: "verified_delivery_baseline", sample_size: 4, confidence_label: "emerging" }] };
      }
      return { rows: [] };
    },
  };
  const result = await refreshAssuranceMemory({
    workspaceId: "workspace-1",
    database,
    now: new Date("2026-08-13T10:00:00Z"),
    policy: { ...DEFAULT_ASSURANCE_POLICY, minimumPatternSample: 3 },
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.filter((sql) => /INSERT INTO assurance_memory_patterns/.test(sql)).length, 2);
  assert.ok(calls.some((sql) => /interpretation/.test(sql) === false));
});

test("moat schema enforces tenant joins, append-only evidence identity, and RLS", () => {
  const sql = read("migrations/20260813c_enterprise_assurance_moat.sql");
  for (const table of [
    "assurance_workspace_policies",
    "assurance_portfolios",
    "assurance_portfolio_goals",
    "assurance_goal_dependencies",
    "assurance_approval_requests",
    "assurance_state_snapshots",
    "assurance_outcome_observations",
    "assurance_memory_patterns",
    "assurance_export_manifests",
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /FOREIGN KEY \(workspace_id, predecessor_goal_id\)/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, successor_goal_id\)/);
  assert.match(sql, /assurance_approval_requested_by_workspace_fkey/);
  assert.match(sql, /FOREIGN KEY \(workspace_id, requested_by\)/);
  assert.match(sql, /idx_goal_assurance_evidence_idempotency/);
  assert.match(sql, /decision_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /sha256 ~ '\^\[a-f0-9\]\{64\}\$'/);
});

test("workspace APIs expose all seven layers through the existing assurance boundary", () => {
  const routes = read("routes/assurance.routes.js");
  for (const route of [
    "/policy",
    "/portfolio",
    "/dependencies",
    "/inbox",
    "/commitments/:id/approval-requests",
    "/executive-report",
    "/export",
  ]) assert.ok(routes.includes(route), `missing ${route}`);
  const service = read("services/enterpriseAssurance.service.js");
  assert.match(service, /ingestExternalAssuranceEvidence/);
  assert.match(service, /refreshAssuranceMemory/);
  assert.match(service, /governed_decision_observation/);
  assert.match(service, /reconcileAllAssuranceWorkspaces/);
  assert.match(service, /jsonb_to_recordset/);
  assert.match(service, /X-Assurance-Export-Sha256|sha256/);
});

test("assurance notifications use the unified inbox without creating chat unread state", () => {
  const service = read("services/enterpriseAssurance.service.js");
  assert.match(service, /type: "assurance_decision"/);
  assert.match(service, /type: "assurance_attention"/);
  assert.ok((service.match(/mirrorToChat: false/g) || []).length >= 3);
  assert.ok((service.match(/broadcastToSlack: false/g) || []).length >= 3);
  const notificationService = read("services/notification.service.js");
  assert.match(notificationService, /mirrorToChat = true/);
  assert.match(notificationService, /Socket emit[\s\S]*?\n  try \{/);
  assert.match(notificationService, /if \(mirrorToChat\)/);
  assert.match(notificationService, /broadcastToSlack = true/);
});

test("manager assurance scope follows assigned projects while admin keeps workspace scope", () => {
  const service = read("services/executionAssurance.service.js");
  assert.match(service, /normalizedRole === "manager"/);
  assert.match(service, /o\.owner_id = \$\$?\{?parameter/);
  assert.match(service, /u\.projects/);
  assert.match(service, /manager_sprint\.project_id = ANY/);
  assert.match(service, /normalizedRole !== "admin"/);
  const routes = read("routes/assurance.routes.js");
  assert.doesNotMatch(routes, /reconcileAssuranceWorkspace/);
  assert.match(routes, /userId: req\.user\.id[\s\S]*role: req\.user\.role/);
  assert.match(routes, /get\("\/policy", allowRoles\("admin"\)/);
  assert.match(routes, /get\("\/portfolio", allowRoles\("manager", "admin"\)/);
  assert.match(routes, /get\("\/executive-report", allowRoles\("manager", "admin"\)/);
});

test("manager portfolio, approval, and reporting queries remain inside visible outcome scope", () => {
  const service = read("services/enterpriseAssurance.service.js");
  assert.match(service, /goal_id=ANY\(\$2::uuid\[\]\)/);
  assert.match(service, /Managers can update only portfolios they own/);
  assert.match(service, /await requireOutcome\(\{ workspaceId, goalId: request\.goal_id, userId: actorId, role, database \}\)/);
  assert.match(service, /d\.predecessor_goal_id=ANY/);
  assert.match(service, /d\.successor_goal_id=ANY/);
  assert.match(service, /ar\.action_type='complete' AND \$2::boolean/);
  assert.match(service, /ar\.action_type='recovery' AND \$3::boolean/);
});

test("production deploy applies and verifies the moat migration before image pull", () => {
  const workflow = read(".github/workflows/deploy-selfhosted.yml");
  const migration = workflow.indexOf("20260813c_enterprise_assurance_moat.sql");
  const verification = workflow.indexOf("enterprise assurance moat migration verified");
  const imagePull = workflow.indexOf('echo "pulling $IMAGE_REF');
  assert.ok(migration >= 0 && verification > migration && imagePull > verification);
});
