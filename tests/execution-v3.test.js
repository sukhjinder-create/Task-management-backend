// tests/execution-v3.test.js
//
// EWIP V3 execution-substrate self-test. Hermetic + deterministic: no DB, no real side
// effects (adapters are injected; the side-effects gate stays OFF except where a fake
// adapter is injected). Covers capability runtime, verification, decision + approval,
// the closed pipeline, workflow interpreter, policy + automation engines, analytics, and
// the flag defaults.

import { test } from "node:test";
import assert from "node:assert/strict";

import { executeCapability, listCapabilities, validateCapabilityInput } from "../execution/capability.js";
import { verifyExecution } from "../execution/verification.js";
import { createDecisionFromRecommendation, resolveDecisionState, decisionEvent, canTransition, validateDecision } from "../execution/decision.js";
import { resolveChain, resolveApprovalState, approvalEvent, pendingApprover } from "../execution/approval.js";
import { runDecisionPipeline } from "../execution/pipeline.js";
import { runWorkflow, validateWorkflow, WORKFLOW_TEMPLATES } from "../execution/workflow.js";
import { createPolicy, validatePolicy, evaluatePolicies, resolveEffectivePolicies } from "../execution/policy.js";
import { createAutomation, validateAutomation, matchTriggers } from "../execution/automation.js";
import { computeExecutionAnalytics } from "../execution/analytics.js";
import { actionLogEntry, validateActionLogEntry } from "../execution/actionlog.js";
import { isExecutionEnabled, areSideEffectsEnabled } from "../execution/config.js";

const WS = "ws-x";
const NOW = Date.parse("2026-07-08T00:00:00Z");
const onGate = () => true;
const fakeExec = (ok, entity) => ({ executionId: "exec_fake", ok, status: ok ? "executed" : "failed", executed: true, simulated: false, entity: entity || null, output: { ok, entity } });

// A recommendation shaped like EI Wave B output.
const recommendation = {
  recommendationId: "rec_1", workspaceId: WS, entity: { type: "Task", id: "t-1" }, status: "recommended",
  requiresApproval: true, manualOnly: false,
  rationaleRefs: { predictionId: "pred_1", reasoningTraceId: "trace_1", evidenceIds: ["evd_1"], attributionIds: ["attr_1"] },
};

// ── Flags default OFF ───────────────────────────────────────────────────────
test("Flags: execution + side-effects default OFF (production untouched)", () => {
  assert.equal(isExecutionEnabled(WS), false);
  assert.equal(areSideEffectsEnabled(WS), false);
});

// ── Capability runtime ──────────────────────────────────────────────────────
test("Capability: dry-run by default; executes with gate+adapter; deterministic; validated", async () => {
  assert.ok(listCapabilities().length >= 6);
  assert.equal(validateCapabilityInput("work.task.create", {}).ok, false); // missing required

  // Side-effects gate OFF → deterministic dry-run, never touches a service.
  const dry = await executeCapability({ workspaceId: WS, key: "work.task.create", input: { title: "X", projectId: "p1" }, context: { idempotencyKey: "k1" }, now: NOW });
  assert.equal(dry.status, "simulated");
  assert.equal(dry.executed, false);
  assert.equal((await executeCapability({ workspaceId: WS, key: "work.task.create", input: { title: "X", projectId: "p1" }, context: { idempotencyKey: "k1" }, now: NOW })).executionId, dry.executionId); // deterministic

  // Gate ON + injected adapter → executes without any real service.
  const live = await executeCapability({ workspaceId: WS, key: "work.task.create", input: { title: "X", projectId: "p1" }, context: { idempotencyKey: "k1" }, now: NOW },
    { areSideEffectsEnabled: onGate, adapters: { "work.task.create": async () => ({ ok: true, entity: { type: "Task", id: "t-99" } }) } });
  assert.equal(live.status, "executed");
  assert.equal(live.entity.id, "t-99");

  const unknown = await executeCapability({ workspaceId: WS, key: "nope", input: {} });
  assert.equal(unknown.status, "failed");
});

test("Verification: simulated→dry_run; executed+entity→verified; failed→retryable", () => {
  assert.equal(verifyExecution({ status: "simulated", executionId: "e" }).mode, "dry_run");
  assert.equal(verifyExecution(fakeExec(true, { type: "Task", id: "t1" }), { entityType: "Task" }).verified, true);
  const f = verifyExecution({ status: "failed", ok: false, executionId: "e", failureReason: "boom" });
  assert.equal(f.verified, false); assert.equal(f.retryable, true);
});

// ── Decision + approval ─────────────────────────────────────────────────────
test("Decision: first-class, references reasoning, deterministic, state from events", () => {
  const d = createDecisionFromRecommendation({ workspaceId: WS, recommendation, proposedAction: { capabilityKey: "work.task.assign", input: { taskId: "t-1", assignedTo: "u-2" } }, now: NOW });
  assert.ok(d.decisionId.startsWith("dec_"));
  assert.equal(d.sourceRecommendationId, "rec_1");
  assert.equal(d.rationaleRefs.reasoningTraceId, "trace_1"); // stays explainable
  assert.equal(validateDecision(d).ok, true);
  assert.deepEqual(createDecisionFromRecommendation({ workspaceId: WS, recommendation, now: NOW }).decisionId, createDecisionFromRecommendation({ workspaceId: WS, recommendation, now: NOW }).decisionId);

  const evs = [decisionEvent({ decisionId: d.decisionId, workspaceId: WS, from: "created", to: "pending_approval", at: NOW }), decisionEvent({ decisionId: d.decisionId, workspaceId: WS, from: "pending_approval", to: "approved", at: NOW + 1 })];
  assert.equal(resolveDecisionState(d, evs).status, "approved");
  assert.equal(canTransition("approved", "executing"), true);
  assert.equal(canTransition("verified", "executing"), false);
});

test("Approval: chains, auto-approve, advance/reject/delegate/timeout, pending approver", () => {
  const d = createDecisionFromRecommendation({ workspaceId: WS, recommendation, now: NOW });
  assert.equal(resolveApprovalState(resolveChain({ decision: d, policy: { mode: "auto" } }), []).status, "approved");

  const chain = resolveChain({ decision: d, policy: { mode: "chain", steps: [{ role: "manager" }, { role: "executive" }] } });
  assert.equal(chain.steps.length, 2);
  const s1 = resolveApprovalState(chain, [approvalEvent({ approvalId: chain.approvalId, workspaceId: WS, action: "approve", step: 0, at: NOW })]);
  assert.equal(s1.status, "pending"); assert.equal(s1.currentStep, 1);
  assert.equal(pendingApprover(chain, s1).role, "executive");
  const s2 = resolveApprovalState(chain, [approvalEvent({ approvalId: chain.approvalId, workspaceId: WS, action: "approve", step: 0, at: NOW }), approvalEvent({ approvalId: chain.approvalId, workspaceId: WS, action: "approve", step: 1, at: NOW + 1 })]);
  assert.equal(s2.status, "approved");
  assert.equal(resolveApprovalState(chain, [approvalEvent({ approvalId: chain.approvalId, workspaceId: WS, action: "reject", step: 0, at: NOW })]).status, "rejected");

  const to = resolveChain({ decision: d, policy: { mode: "manager", onTimeout: "reject" } });
  assert.equal(resolveApprovalState(to, [approvalEvent({ approvalId: to.approvalId, workspaceId: WS, action: "timeout", step: 0, at: NOW })]).status, "rejected");
});

// ── Pipeline ────────────────────────────────────────────────────────────────
test("Pipeline: awaits approval, then executes + verifies deterministically", async () => {
  const d = createDecisionFromRecommendation({ workspaceId: WS, recommendation, proposedAction: { capabilityKey: "work.task.create", input: { title: "X", projectId: "p1" } }, now: NOW });

  const waiting = await runDecisionPipeline({ workspaceId: WS, decision: d, approvalPolicy: { mode: "manager" }, approvalEvents: [], now: NOW });
  assert.equal(waiting.stage, "awaiting_approval");

  const done = await runDecisionPipeline({ workspaceId: WS, decision: d, approvalPolicy: { mode: "auto" }, now: NOW }, { executeCapability: async () => fakeExec(true, { type: "Task", id: "t-1" }) });
  assert.equal(done.stage, "completed");
  assert.ok(done.events.some((e) => e.to === "verified"));

  const failed = await runDecisionPipeline({ workspaceId: WS, decision: d, approvalPolicy: { mode: "auto" }, now: NOW }, { executeCapability: async () => fakeExec(false) });
  assert.equal(failed.stage, "failed");
});

// ── Workflow ────────────────────────────────────────────────────────────────
test("Workflow: valid, deterministic, conditional branch + compensation on failure", async () => {
  assert.equal(validateWorkflow(WORKFLOW_TEMPLATES.delivery_risk_response).ok, true);

  const def = {
    key: "wf", version: 1,
    nodes: [{ id: "s", type: "start" }, { id: "A", type: "capability", capabilityKey: "kA", compensation: { capabilityKey: "compA" } }, { id: "B", type: "capability", capabilityKey: "kB" }, { id: "e", type: "end" }],
    edges: [{ from: "s", to: "A" }, { from: "A", to: "B", branch: "success" }, { from: "B", to: "e", branch: "success" }],
  };
  const run = await runWorkflow({ workspaceId: WS, definition: def, context: { idempotencyKey: "w1" }, now: NOW },
    { executeCapability: async ({ context }) => fakeExec(context.node !== "B") });
  assert.equal(run.status, "failed");
  assert.ok(run.steps.some((s) => s.type === "compensation" && s.node === "A")); // rollback ran
});

// ── Policy + automation ─────────────────────────────────────────────────────
test("Policy: IF/THEN evaluation + lock hierarchy overrides", () => {
  const plat = createPolicy({ scope: "PLATFORM", key: "risk_escalation", when: { field: "risk", op: "gt", value: 80 }, then: { action: "work.risk.escalate" }, lockLevel: "global_locked" });
  assert.equal(validatePolicy(plat).ok, true);
  assert.equal(evaluatePolicies({ risk: 90 }, [plat]).length, 1);
  assert.equal(evaluatePolicies({ risk: 50 }, [plat]).length, 0);

  const wsOverride = createPolicy({ scope: WS, workspaceId: WS, key: "risk_escalation", when: { field: "risk", op: "gt", value: 99 }, then: { action: "noop" } });
  // global_locked platform policy cannot be overridden by the workspace.
  const eff = resolveEffectivePolicies([plat], [wsOverride]);
  assert.equal(eff.find((p) => p.key === "risk_escalation").lockLevel, "global_locked");
});

test("Automation: triggers match deterministically", () => {
  const a = createAutomation({ workspaceId: WS, key: "on_slip", trigger: { type: "event", event: "task.slipped" }, action: { kind: "capability", ref: "work.risk.escalate" } });
  assert.equal(validateAutomation(a).ok, true);
  assert.equal(matchTriggers({ type: "event", event: "task.slipped" }, [a]).length, 1);
  assert.equal(matchTriggers({ type: "event", event: "other" }, [a]).length, 0);
  const cond = createAutomation({ workspaceId: WS, key: "hi_risk", trigger: { type: "conditional", condition: { field: "risk", op: "gte", value: 80 } }, action: { kind: "workflow", ref: "delivery_risk_response" } });
  assert.equal(matchTriggers({ type: "conditional", facts: { risk: 85 } }, [cond]).length, 1);
});

// ── Analytics + action log ──────────────────────────────────────────────────
test("Analytics: success rate from evidence; ROI/adoption insufficient (not fabricated)", () => {
  const executions = [fakeExec(true, { id: "1" }), { ...fakeExec(false), status: "failed" }, { status: "simulated" }].map((e, i) => ({ ...e, startedAt: "2026-07-08T00:00:00Z", endedAt: "2026-07-08T00:00:01Z", executionId: "e" + i }));
  const m = Object.fromEntries(computeExecutionAnalytics({ executions, actions: [] }).map((x) => [x.key, x]));
  assert.equal(m.execution_success_rate.value, 0.5); // 1 of 2 live
  assert.equal(m.roi.evidenceSufficient, false);
  assert.equal(m.adoption.evidenceSufficient, false);

  const entry = actionLogEntry({ workspaceId: WS, type: "execution", refId: "e1", actor: { id: "u1" }, at: NOW });
  assert.equal(validateActionLogEntry(entry).ok, true);
  assert.equal(actionLogEntry({ workspaceId: WS, type: "execution", refId: "e1", actor: { id: "u1" }, at: NOW }).actionId, entry.actionId);
});
