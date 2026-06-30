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

test("operational event capture maps core product routes to semantic events", () => {
  assert.deepEqual(
    deriveEventDescriptor("POST", "/tasks"),
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

test("deterministic reasoner explains overdue and blocked work using supplied context only", () => {
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
  assert.equal(reasoning.model, "deterministic_operational_reasoner_v1");
  assert.ok(reasoning.recommendations.some((item) => item.ruleKey === "overdue_task_review"));
  assert.ok(reasoning.recommendations.some((item) => item.ruleKey === "blocked_task_escalation"));
  assert.ok(reasoning.evidence.every((item) => item.source === "task.service"));
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
