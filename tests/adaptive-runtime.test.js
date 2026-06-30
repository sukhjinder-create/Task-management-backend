import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

import { deriveEventDescriptor } from "../adaptive/events/operationalEvent.middleware.js";
import { reasonFromOperationalContext } from "../adaptive/reasoning/reasoningEngine.service.js";
import { redact, stableHash } from "../adaptive/shared/runtimeUtils.js";
import { validateWorkflowDefinition } from "../adaptive/workflows/workflowValidator.js";
import { registerDefaultCapabilities } from "../adaptive/capabilities/defaultCapabilities.js";
import { clearCapabilitiesForTests, listCapabilities } from "../adaptive/capabilities/capabilityRegistry.js";
import { getJwtSecret, secretMatches } from "../config/secrets.js";
import { validateDomainEvent } from "../adaptive/events/domainEventContracts.js";
import { assertExecutableApproval } from "../adaptive/approvals/approvalInvariant.js";
import { applyAdaptivePolicy } from "../adaptive/personalization/adaptivePolicy.service.js";

test("operational event capture maps core product routes to semantic events", () => {
  assert.deepEqual(
    deriveEventDescriptor("POST", "/tasks"),
    { eventType: "TASK_CREATED", entityType: "task" }
  );
  assert.deepEqual(
    deriveEventDescriptor("POST", "/tasks/11111111-1111-4111-8111-111111111111"),
    { eventType: "TASK_CREATED", entityType: "task" }
  );
  assert.deepEqual(
    deriveEventDescriptor("PATCH", "/tasks/11111111-1111-4111-8111-111111111111/status"),
    { eventType: "TASK_STATUS_CHANGED", entityType: "task" }
  );
  assert.deepEqual(
    deriveEventDescriptor("POST", "/huddle/intelligence/11111111-1111-4111-8111-111111111111/finalize"),
    { eventType: "MEETING_INTELLIGENCE_UPDATED", entityType: "meeting" }
  );
});

test("runtime redaction strips sensitive request data before events are stored", () => {
  const output = redact({
    token: "abc",
    nested: { password: "pw", visible: "yes" },
    items: [{ client_secret: "secret", ok: true }],
  });
  assert.equal(output.token, "[redacted]");
  assert.equal(output.nested.password, "[redacted]");
  assert.equal(output.nested.visible, "yes");
  assert.equal(output.items[0].client_secret, "[redacted]");
});

test("evidence-constrained planner explains risk and selects coordinated capabilities", () => {
  const event = {
    eventId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    actorUserId: "44444444-4444-4444-8444-444444444444",
    eventType: "TASK_UPDATED",
  };
  const context = {
    coverage: 1,
    sources: [{ key: "task", status: "available" }],
    data: {
      task: {
        id: "55555555-5555-4555-8555-555555555555",
        task: "Ship investor demo",
        status: "blocked",
        due_date: "2026-01-01",
        assigned_to: "66666666-6666-4666-8666-666666666666",
        project_id: "77777777-7777-4777-8777-777777777777",
      },
    },
  };
  const reasoning = reasonFromOperationalContext({ event, context, now: new Date("2026-06-30T00:00:00Z") });
  assert.equal(reasoning.explainable, true);
  assert.equal(reasoning.model, "evidence_constrained_operational_planner_v2");
  assert.ok(reasoning.recommendations.some((item) => item.ruleKey === "overdue_task_review"));
  assert.ok(reasoning.recommendations.some((item) => item.ruleKey === "blocked_task_escalation"));
  assert.ok(reasoning.evidence.every((item) => item.source === "task.service"));
  assert.ok(reasoning.recommendations.some((item) => item.capabilityKey === "notification.send"));
  assert.ok(reasoning.recommendations.some((item) => item.capabilityKey === "autopilot.analyze"));
  assert.ok(reasoning.recommendations.every((item) => item.plan?.id));
});

test("canonical event contracts reject entity drift and preserve v1 compatibility", () => {
  const valid = validateDomainEvent({
    workspaceId: "33333333-3333-4333-8333-333333333333",
    eventType: "TASK_CREATED",
    entityType: "task",
    schemaVersion: 1,
  }, { allowUnknown: false });
  assert.equal(valid.valid, true);
  const drifted = validateDomainEvent({
    workspaceId: "33333333-3333-4333-8333-333333333333",
    eventType: "TASK_CREATED",
    entityType: "tasks",
    schemaVersion: 1,
  }, { allowUnknown: false });
  assert.equal(drifted.valid, false);
  assert.ok(drifted.errors.some((message) => message.includes("entityType=task")));
});

test("approval-required and manual-only actions cannot execute while pending", () => {
  for (const approvalMode of ["approval_required", "manual_only"]) {
    assert.throws(
      () => assertExecutableApproval({ status: "pending", approval_mode: approvalMode }),
      (error) => error.code === "ACTION_APPROVAL_REQUIRED"
    );
    assert.equal(assertExecutableApproval({
      status: "approved",
      approval_mode: approvalMode,
      approved_by: "44444444-4444-4444-8444-444444444444",
      approved_at: new Date().toISOString(),
    }), true);
  }
});

test("meeting completion creates a governed multi-capability execution plan", () => {
  const reasoning = reasonFromOperationalContext({
    event: {
      eventId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      actorUserId: "44444444-4444-4444-8444-444444444444",
      eventType: "MEETING_ENDED",
      entityType: "meeting",
      entityId: "88888888-8888-4888-8888-888888888888",
      metadata: { projectId: "77777777-7777-4777-8777-777777777777", summary: "Release decision recorded" },
    },
    context: { coverage: 0.8, sources: [], data: { operationalGraph: { meetings: [{ session_id: "88888888-8888-4888-8888-888888888888", digest_json: { summary: "Release decision recorded" } }], relevance: { projectId: "77777777-7777-4777-8777-777777777777" } } } },
  });
  const capabilities = new Set(reasoning.recommendations.map((item) => item.capabilityKey));
  assert.ok(capabilities.has("workspace_memory.create"));
  assert.ok(capabilities.has("executive_summary.generate"));
  assert.ok(capabilities.has("notification.send"));
});

test("repeated scoped rejection suppresses non-critical notification behaviour", async () => {
  const policy = await applyAdaptivePolicy({
    event: { workspaceId: "33333333-3333-4333-8333-333333333333", actorUserId: null, metadata: {} },
    context: { coverage: 0.8, data: { operationalGraph: { relevance: {} } } },
    recommendations: [{
      ruleKey: "overdue_task_review",
      confidence: 0.93,
      capabilityKey: "notification.send",
      riskLevel: "medium",
    }],
    priorLoader: async () => ({
      probability: 0.05,
      source: "project_profile_v8",
      explanation: "Derived from 20 reversible recommendation feedback signals in this scope.",
      scopeType: "project",
      scopeId: "77777777-7777-4777-8777-777777777777",
      sampleCount: 20,
    }),
  });
  assert.equal(policy.proposed.length, 0);
  assert.equal(policy.suppressed.length, 1);
  assert.equal(policy.suppressed[0].confidenceModel.acceptanceProbability, 0.05);
  assert.match(policy.suppressed[0].policyExplanation, /Suppressed/);
});

test("workflow validator accepts the simple WHEN IF APPROVAL THEN END DSL", () => {
  clearCapabilitiesForTests();
  registerDefaultCapabilities();
  assert.ok(listCapabilities().some((capability) => capability.key === "notification.send"));
  const result = validateWorkflowDefinition({
    steps: [
      { type: "WHEN", eventTypes: ["TASK_UPDATED"] },
      { type: "IF", path: "context.data.task.status", operator: "equals", value: "blocked" },
      { type: "APPROVAL", mode: "approval_required" },
      {
        type: "THEN",
        capabilityKey: "notification.send",
        input: {
          title: "Blocked task",
          message: "Please review this blocker.",
        },
      },
      { type: "END" },
    ],
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("workflow validator rejects unknown capabilities and unsafe wait ranges", () => {
  clearCapabilitiesForTests();
  registerDefaultCapabilities();
  const result = validateWorkflowDefinition({
    steps: [
      { type: "WHEN", eventTypes: ["TASK_UPDATED"] },
      { type: "WAIT", durationMinutes: 0 },
      { type: "THEN", capabilityKey: "unknown.capability" },
      { type: "END" },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("WAIT")));
  assert.ok(result.errors.some((message) => message.includes("unknown capability")));
});

test("runtime hashes are stable and JWT secret is shared by auth surfaces", () => {
  const first = stableHash({ a: 1, b: ["x"] });
  const second = stableHash({ a: 1, b: ["x"] });
  assert.equal(first, second);
  assert.equal(secretMatches("same", "same"), true);
  assert.equal(secretMatches("same", "different"), false);
  const token = jwt.sign({ id: "user-1", role: "admin", workspaceId: "workspace-1" }, getJwtSecret(), { expiresIn: "1m" });
  assert.equal(jwt.verify(token, getJwtSecret()).id, "user-1");
});
