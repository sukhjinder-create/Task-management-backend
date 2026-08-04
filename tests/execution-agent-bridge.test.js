// tests/execution-agent-bridge.test.js
//
// The bot → execution bridge: agent-origin decisions, the approval line, and the
// safety properties that make an action-taking agent deployable.
//
// Pure/hermetic — the engines under test are deterministic, and nothing here
// touches a database or a provider.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDecisionFromAgent, createDecisionFromRecommendation, validateDecision } from "../execution/decision.js";
import {
  resolveAgentApproval,
  toApprovalPolicy,
  AGENT_ACTION_POLICY,
  DEFAULT_UNKNOWN_POLICY,
} from "../execution/agentPolicy.js";
import { resolveChain, resolveApprovalState, approvalEvent, pendingApprover } from "../execution/approval.js";
import { runDecisionPipeline } from "../execution/pipeline.js";
import { CAPABILITY_CATALOG } from "../execution/capability.js";

const TRIGGER = {
  messageId: "msg_123",
  channelKey: "channel:apy3",
  text: "get someone on the login timeout before friday",
  userId: "user_rahul",
  userRole: "manager",
  toolCall: { name: "create_task", arguments: { title: "Fix login timeout" }, argumentsValid: true },
  model: "groq/llama-3.3-70b-versatile",
};

const PROPOSED = { capabilityKey: "work.task.create", input: { title: "Fix login timeout", projectId: "proj_1" } };

// ── Agent-origin decisions ──────────────────────────────────────────────────

test("an agent decision satisfies the SAME validation as an EI decision", () => {
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  const check = validateDecision(decision);
  assert.equal(check.ok, true, `agent decisions must validate: ${check.errors}`);
  // Explainability is NOT waived for agent origin — the trace is mandatory.
  assert.ok(decision.rationaleRefs.reasoningTraceId, "must carry a reasoning trace");
  assert.ok(decision.sourceRecommendationId, "must carry a source id");
});

test("traceability points at REAL evidence: the message and the tool call", () => {
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  assert.deepEqual(decision.rationaleRefs.evidenceIds, ["msg_123"], "evidence is the triggering message");
  assert.deepEqual(decision.rationaleRefs.attributionIds, ["user_rahul"], "attributed to the requester");
  assert.equal(decision.provenance.origin, "agent");
  assert.equal(decision.provenance.toolCall.name, "create_task");
  assert.equal(decision.provenance.triggerMessageId, "msg_123");
});

test("the channel is carried so the outcome can be posted back", () => {
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  assert.equal(decision.provenance.channelKey, "channel:apy3");
});

test("agent decisions are IDEMPOTENT — the same trigger yields the same ids", () => {
  const now = 1_700_000_000_000;
  const a = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED, now });
  const b = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED, now });
  assert.equal(a.decisionId, b.decisionId, "a retried proposal must not create a second decision");
  assert.equal(a.rationaleRefs.reasoningTraceId, b.rationaleRefs.reasoningTraceId);
});

test("a different message produces a different decision", () => {
  const now = 1_700_000_000_000;
  const a = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED, now });
  const b = createDecisionFromAgent({ workspaceId: "ws1", trigger: { ...TRIGGER, messageId: "msg_999" }, proposedAction: PROPOSED, now });
  assert.notEqual(a.decisionId, b.decisionId);
});

test("malformed proposals are rejected, not half-built", () => {
  assert.equal(createDecisionFromAgent({ workspaceId: "ws1", trigger: {}, proposedAction: PROPOSED }), null);
  assert.equal(createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: {} }), null);
  assert.equal(createDecisionFromAgent({ trigger: TRIGGER, proposedAction: PROPOSED }), null);
});

test("REGRESSION: EI-originated decisions are unaffected", () => {
  const decision = createDecisionFromRecommendation({
    workspaceId: "ws1",
    recommendation: { recommendationId: "rec_1", rationaleRefs: { reasoningTraceId: "trace_1" } },
    proposedAction: PROPOSED,
  });
  assert.equal(validateDecision(decision).ok, true);
  assert.equal(decision.provenance.origin, undefined, "EI decisions carry no agent origin marker");
});

// ── The approval line ───────────────────────────────────────────────────────

test("every catalogued capability has a stated approval mode and a reason", () => {
  for (const key of Object.keys(CAPABILITY_CATALOG)) {
    const entry = AGENT_ACTION_POLICY[key];
    assert.ok(entry, `${key} needs an approval policy`);
    assert.ok(["auto", "manager", "admin", "executive"].includes(entry.mode), `${key} mode`);
    assert.ok(entry.why.length > 20, `${key} must explain itself to the user`);
  }
});

test("blast radius drives the line: create/notify auto, mutations manager, escalation admin", () => {
  assert.equal(resolveAgentApproval("work.task.create").mode, "auto");
  assert.equal(resolveAgentApproval("work.team.notify").mode, "auto");
  assert.equal(resolveAgentApproval("work.task.assign").mode, "manager");
  assert.equal(resolveAgentApproval("work.task.update").mode, "manager");
  assert.equal(resolveAgentApproval("work.task.priority").mode, "manager");
  assert.equal(resolveAgentApproval("work.risk.escalate").mode, "admin");
});

test("SAFETY: an uncatalogued capability fails CLOSED to admin", () => {
  const resolved = resolveAgentApproval("work.database.drop");
  assert.equal(resolved.mode, "admin");
  assert.equal(resolved.source, "default:unknown");
  assert.equal(resolved.why, DEFAULT_UNKNOWN_POLICY.why);
});

test("a workspace policy can move the line without a deploy", () => {
  const resolved = resolveAgentApproval("work.task.create", {
    policyMatches: [{ policyId: "pol_1", key: "strict-task-creation", action: "work.task.create", params: { approvalMode: "admin", why: "Regulated tenant." } }],
  });
  assert.equal(resolved.mode, "admin", "configured policy must beat the default");
  assert.equal(resolved.source, "policy:pol_1");
  assert.equal(resolved.why, "Regulated tenant.");
});

test("an invalid policy mode is ignored rather than trusted", () => {
  const resolved = resolveAgentApproval("work.risk.escalate", {
    policyMatches: [{ policyId: "pol_x", key: "bad", action: "work.risk.escalate", params: { approvalMode: "nobody" } }],
  });
  assert.equal(resolved.mode, "admin", "falls back to the safe default");
});

test("dry-run mode skips approval friction but still records everything", () => {
  const resolved = resolveAgentApproval("work.risk.escalate", { sideEffectsEnabled: false });
  assert.equal(resolved.mode, "auto");
  assert.equal(resolved.source, "dry_run");
  assert.match(resolved.why, /Dry run/);
});

test("toApprovalPolicy produces what the pipeline expects and defaults safely", () => {
  assert.equal(toApprovalPolicy("admin").mode, "admin");
  assert.equal(toApprovalPolicy("nonsense").mode, "manager", "unknown modes default to manager, not auto");
});

// ── End-to-end pipeline behaviour ───────────────────────────────────────────

/** Capability executor stub — records what it was asked to do. */
function stubExecutor(calls) {
  return async ({ workspaceId, key, input }) => {
    calls.push({ key, input });
    return {
      executionId: `exec_${calls.length}`, workspaceId, capabilityKey: key,
      ok: true, status: "executed", executed: true, simulated: false,
      output: { created: true }, entity: { type: "Task", id: "task_1" },
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
    };
  };
}

test("an AUTO-approved agent action executes in one pass", async () => {
  const calls = [];
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  const result = await runDecisionPipeline(
    { workspaceId: "ws1", decision, approvalPolicy: toApprovalPolicy("auto") },
    { executeCapability: stubExecutor(calls) }
  );
  assert.equal(result.stage, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "work.task.create");
});

test("an action needing approval does NOT execute until a human approves", async () => {
  const calls = [];
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  const policy = toApprovalPolicy("manager");

  const held = await runDecisionPipeline(
    { workspaceId: "ws1", decision, approvalPolicy: policy, approvalEvents: [] },
    { executeCapability: stubExecutor(calls) }
  );
  assert.equal(held.stage, "awaiting_approval");
  assert.equal(calls.length, 0, "NOTHING may execute before approval");

  // A manager approves…
  const approval = resolveChain({ decision, policy });
  const approved = await runDecisionPipeline(
    {
      workspaceId: "ws1", decision, approvalPolicy: policy,
      approvalEvents: [approvalEvent({ approvalId: approval.approvalId, workspaceId: "ws1", action: "approve", step: 0, actor: { id: "u_admin" } })],
    },
    { executeCapability: stubExecutor(calls) }
  );
  assert.equal(approved.stage, "completed");
  assert.equal(calls.length, 1, "…and only then does it execute");
});

test("a rejection never executes", async () => {
  const calls = [];
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  const policy = toApprovalPolicy("manager");
  const approval = resolveChain({ decision, policy });
  const result = await runDecisionPipeline(
    {
      workspaceId: "ws1", decision, approvalPolicy: policy,
      approvalEvents: [approvalEvent({ approvalId: approval.approvalId, workspaceId: "ws1", action: "reject", step: 0, actor: { id: "u_admin" } })],
    },
    { executeCapability: stubExecutor(calls) }
  );
  assert.equal(result.stage, "awaiting_approval");
  assert.equal(calls.length, 0);
});

test("the approval chain names who is expected to act", () => {
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  const policy = toApprovalPolicy("admin");
  const approval = resolveChain({ decision, policy });
  const state = resolveApprovalState(approval, []);
  assert.equal(pendingApprover(approval, state).role, "admin");
});

test("the full lifecycle is captured as append-only events", async () => {
  const decision = createDecisionFromAgent({ workspaceId: "ws1", trigger: TRIGGER, proposedAction: PROPOSED });
  const result = await runDecisionPipeline(
    { workspaceId: "ws1", decision, approvalPolicy: toApprovalPolicy("auto") },
    { executeCapability: stubExecutor([]) }
  );
  const transitions = result.events.map((e) => `${e.from}->${e.to}`);
  assert.deepEqual(transitions, [
    "created->pending_approval",
    "pending_approval->approved",
    "approved->executing",
    "executing->executed",
    "executed->verified",
  ]);
  // Every event is attributable and timestamped — this is the audit spine.
  for (const event of result.events) {
    assert.ok(event.eventId && event.occurredAt && event.decisionId);
  }
});
