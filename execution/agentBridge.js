// execution/agentBridge.js
//
// THE BRIDGE: AI agent proposals → the governed execution pipeline.
//
// Before this, the assistant performed actions directly (ai-task → POST
// /internal/tasks/create-from-ai → row inserted). The "approval" was one word in
// a chat box, the audit trail was a single provenance row, and there was no
// policy, no verification and no record of what else the agent could have done.
//
// Here the agent stops ACTING and starts PROPOSING. Every proposal becomes a
// first-class Decision that flows through decision → approval → capability
// runtime → verification → action log, exactly like an EI-originated decision.
// Nothing is special-cased for the agent: it is simply another decision source.
//
// SAFETY PROPERTIES
//   • Inert unless EXEC_ENABLED — callers fall back to the direct path.
//   • Side-effects gate still governs mutation: with it OFF every action is a
//     deterministic dry-run that is still fully recorded (ideal for piloting).
//   • The approval line comes from agentPolicy.js and is overridable per
//     workspace through the existing policy engine.
//   • Capability inputs are validated by the capability runtime, and slot
//     resolution below refuses to guess: an unresolvable project or assignee
//     returns a question for the user rather than a wrong write.

import pool from "../db.js";
import { createDecisionFromAgent } from "./decision.js";
import { resolveChain, resolveApprovalState, approvalEvent, pendingApprover } from "./approval.js";
import { runDecisionPipeline } from "./pipeline.js";
import { actionLogEntry } from "./actionlog.js";
import { resolveAgentApproval, toApprovalPolicy } from "./agentPolicy.js";
import { getCapability } from "./capability.js";
import { evaluatePolicies, resolveEffectivePolicies } from "./policy.js";
import { isExecutionEnabled, areSideEffectsEnabled } from "./config.js";
import * as store from "./stores.js";

/** Role ranking used to decide whether an approver satisfies a required step. */
const ROLE_RANK = { member: 0, manager: 1, admin: 2, executive: 3, superadmin: 4 };

function satisfiesRole(actorRole, requiredRole) {
  if (!requiredRole) return true;
  return (ROLE_RANK[String(actorRole || "").toLowerCase()] ?? -1) >= (ROLE_RANK[requiredRole] ?? 99);
}

// ── Slot resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a project NAME (what a person says) to a project id (what the
 * capability needs). Returns null rather than guessing — the caller turns that
 * into a question instead of writing to the wrong project.
 */
async function resolveProjectId(workspaceId, projectName) {
  if (!projectName) return null;
  const { rows } = await pool.query(
    `SELECT id, name FROM projects
     WHERE workspace_id = $1 AND LOWER(name) = LOWER($2)
     LIMIT 1`,
    [workspaceId, String(projectName).trim()]
  );
  return rows[0]?.id ?? null;
}

/**
 * Translate the agent's natural-language slots into a validated capability input.
 * @returns {Promise<{ok: boolean, input?: object, missing?: string, message?: string}>}
 */
export async function resolveCapabilityInput({ workspaceId, capabilityKey, slots = {} }) {
  const capability = getCapability(capabilityKey);
  if (!capability) return { ok: false, missing: "capability", message: `Unknown capability "${capabilityKey}".` };

  if (capabilityKey === "work.task.create") {
    if (!slots.title) return { ok: false, missing: "title", message: "What should the task be called?" };
    if (!slots.projectName && !slots.projectId) {
      return { ok: false, missing: "project", message: "Which project should this task belong to?" };
    }
    const projectId = slots.projectId || (await resolveProjectId(workspaceId, slots.projectName));
    if (!projectId) {
      return {
        ok: false,
        missing: "project",
        message: `I couldn't find a project called "${slots.projectName}" in this workspace. Which project should I use?`,
      };
    }
    return {
      ok: true,
      input: {
        title: String(slots.title).trim(),
        projectId,
        ...(slots.assignedTo ? { assignedTo: slots.assignedTo } : {}),
        ...(slots.dueDate ? { dueDate: slots.dueDate } : {}),
        ...(slots.description ? { description: slots.description } : {}),
        ...(slots.priority ? { priority: String(slots.priority) } : {}),
      },
    };
  }

  if (capabilityKey === "work.team.notify" || capabilityKey === "work.risk.escalate") {
    if (!slots.userId) return { ok: false, missing: "user", message: "Who should I notify?" };
    return {
      ok: true,
      input: {
        userId: slots.userId,
        message: slots.message || slots.title || "You have an update in Asystence",
        ...(slots.title ? { title: slots.title } : {}),
      },
    };
  }

  // Task mutations operate on an existing task the agent must already have identified.
  if (["work.task.assign", "work.task.update", "work.task.priority"].includes(capabilityKey)) {
    if (!slots.taskId) return { ok: false, missing: "task", message: "Which task did you mean?" };
    if (capabilityKey === "work.task.assign" && !slots.assignedTo) {
      return { ok: false, missing: "assignee", message: "Who should I assign it to?" };
    }
    if (capabilityKey === "work.task.priority" && !slots.priority) {
      return { ok: false, missing: "priority", message: "What priority should it be?" };
    }
    return {
      ok: true,
      input: {
        taskId: slots.taskId,
        ...(slots.assignedTo ? { assignedTo: slots.assignedTo } : {}),
        ...(slots.priority ? { priority: String(slots.priority) } : {}),
        ...(slots.changes ? { changes: slots.changes } : {}),
      },
    };
  }

  return { ok: false, missing: "capability", message: "That action isn't something I can do yet." };
}

// ── Proposal ────────────────────────────────────────────────────────────────

/** Load the effective policy set so a workspace can move the approval line. */
async function effectivePolicyMatches(workspaceId, facts) {
  try {
    const platform = (await store.listPolicies({ scope: "PLATFORM" })).map(rowToPolicy);
    const workspace = (await store.listPolicies({ workspaceId })).map(rowToPolicy);
    return evaluatePolicies(facts, resolveEffectivePolicies(platform, workspace));
  } catch {
    return []; // policies are optional; defaults apply
  }
}

const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; } };
function rowToPolicy(r) {
  return {
    policyId: r.policy_id, scope: r.scope, workspaceId: r.workspace_id, key: r.key,
    when: parse(r.when_json), then: parse(r.then_json), version: r.version,
    lockLevel: r.lock_level, enabled: r.enabled,
  };
}

/**
 * Turn an agent proposal into a governed decision and run it as far as policy allows.
 *
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {string} p.capabilityKey
 * @param {object} p.slots     natural-language slots extracted by the agent
 * @param {object} p.trigger   { messageId, channelKey, text, userId, userRole, toolCall, model }
 * @returns {Promise<object>} outcome the agent renders in chat
 */
export async function proposeAgentAction({ workspaceId, capabilityKey, slots = {}, trigger = {} }) {
  if (!isExecutionEnabled(workspaceId)) {
    return { ok: false, status: "execution_disabled" };
  }

  const resolved = await resolveCapabilityInput({ workspaceId, capabilityKey, slots });
  if (!resolved.ok) {
    // Not an error — the agent asks the user for the missing piece.
    return { ok: false, status: "needs_input", missing: resolved.missing, message: resolved.message };
  }

  const sideEffectsEnabled = areSideEffectsEnabled(workspaceId);
  const matches = await effectivePolicyMatches(workspaceId, {
    capabilityKey,
    requesterRole: trigger.userRole ?? null,
    ...slots,
  });
  const approvalDecision = resolveAgentApproval(capabilityKey, { policyMatches: matches, sideEffectsEnabled });

  const decision = createDecisionFromAgent({
    workspaceId,
    trigger,
    proposedAction: { capabilityKey, input: resolved.input },
    requiresApproval: approvalDecision.mode !== "auto",
  });
  if (!decision) return { ok: false, status: "invalid_proposal" };

  const approvalPolicy = toApprovalPolicy(approvalDecision.mode);
  const approval = resolveChain({ decision, policy: approvalPolicy });

  await store.appendDecision(decision);
  await store.appendApprovalRequest(approval);
  await store.appendActionLog(
    actionLogEntry({
      workspaceId, type: "decision_created", refId: decision.decisionId,
      actor: { type: "agent", id: "ai-task" },
      payload: { capabilityKey, origin: "agent", approvalMode: approvalDecision.mode, triggerMessageId: trigger.messageId },
    })
  ).catch(() => {});

  const result = await runDecisionPipeline({
    workspaceId, decision, approvalPolicy, approvalEvents: [],
    actor: { type: "agent", id: "ai-task" },
  });

  await persistPipelineResult(workspaceId, result);

  return {
    ok: true,
    status: result.stage,                       // completed | awaiting_approval | failed | approved_no_action
    decisionId: decision.decisionId,
    approvalId: approval.approvalId,
    capabilityKey,
    capabilityTitle: getCapability(capabilityKey)?.title ?? capabilityKey,
    input: resolved.input,
    approvalMode: approvalDecision.mode,
    approvalReason: approvalDecision.why,
    approvalSource: approvalDecision.source,
    pendingApprover: pendingApprover(approval, result.approvalState),
    simulated: Boolean(result.execution?.simulated),
    executed: Boolean(result.execution?.executed),
    entity: result.execution?.entity ?? null,
    verified: result.verification?.verified ?? null,
    channelKey: trigger.channelKey ?? null,
  };
}

async function persistPipelineResult(workspaceId, result) {
  for (const event of result.events || []) {
    await store.appendDecisionEvent(event);
  }
  if (result.execution) {
    await store.appendExecution(result.execution);
    await store.appendVerification(result.verification, result.execution.executionId, workspaceId);
    await store.appendActionLog(
      actionLogEntry({
        workspaceId, type: "execution", refId: result.execution.executionId,
        actor: { type: "agent", id: "ai-task" },
        payload: { key: result.execution.capabilityKey, status: result.execution.status, simulated: result.execution.simulated },
      })
    ).catch(() => {});
  }
}

// ── Approval from chat ──────────────────────────────────────────────────────

/**
 * Record an approve/reject made from chat, then resume the pipeline.
 *
 * Authorization is enforced HERE against the approval chain's required role —
 * the agent relays the click but never decides whether it counts.
 */
export async function decideAgentApproval({ workspaceId, decisionId, action, actor }) {
  if (!isExecutionEnabled(workspaceId)) return { ok: false, status: "execution_disabled" };
  if (!["approve", "reject"].includes(action)) return { ok: false, status: "invalid_action" };

  const rows = await store.listDecisions({ workspaceId });
  const row = rows.find((r) => r.decision_id === decisionId);
  if (!row) return { ok: false, status: "decision_not_found" };

  const decision = {
    decisionId: row.decision_id,
    workspaceId: row.workspace_id,
    entity: parse(row.entity_json),
    proposedAction: parse(row.proposed_action_json),
    rationaleRefs: parse(row.rationale_refs_json),
    requiresApproval: row.requires_approval,
    manualOnly: row.manual_only,
    provenance: parse(row.provenance_json),
  };

  const capabilityKey = decision.proposedAction?.capabilityKey;
  const approvalDecision = resolveAgentApproval(capabilityKey, {
    sideEffectsEnabled: areSideEffectsEnabled(workspaceId),
  });
  const approvalPolicy = toApprovalPolicy(approvalDecision.mode);
  const approval = resolveChain({ decision, policy: approvalPolicy });

  const priorEvents = (await store.listApprovalEvents({ workspaceId, approvalId: approval.approvalId })).map(mapApprovalRow);
  const state = resolveApprovalState(approval, priorEvents);
  if (state.status !== "pending") {
    return { ok: false, status: "already_resolved", approvalState: state.status };
  }

  const required = pendingApprover(approval, state);
  if (!satisfiesRole(actor?.role, required?.role)) {
    return { ok: false, status: "forbidden", requiredRole: required?.role ?? null };
  }
  // A delegated/named approver, when set, must be the one acting.
  if (required?.approverId && String(required.approverId) !== String(actor?.id)) {
    return { ok: false, status: "forbidden", requiredApproverId: required.approverId };
  }
  // The requester cannot rubber-stamp their own proposal.
  if (decision.provenance?.requestedBy?.id && String(decision.provenance.requestedBy.id) === String(actor?.id)) {
    return { ok: false, status: "self_approval_forbidden" };
  }

  const event = approvalEvent({
    approvalId: approval.approvalId, workspaceId, action,
    step: state.currentStep, actor: { type: "user", id: actor?.id, role: actor?.role },
  });
  await store.appendApprovalEvent(event);
  await store.appendActionLog(
    actionLogEntry({
      workspaceId, type: "approval_decision", refId: approval.approvalId,
      actor: { type: "user", id: actor?.id, role: actor?.role },
      payload: { action, decisionId, capabilityKey },
    })
  ).catch(() => {});

  if (action === "reject") {
    return { ok: true, status: "rejected", decisionId, capabilityKey, channelKey: decision.provenance?.channelKey ?? null };
  }

  const result = await runDecisionPipeline({
    workspaceId, decision, approvalPolicy,
    approvalEvents: [...priorEvents, event],
    actor: { type: "user", id: actor?.id, role: actor?.role },
  });
  await persistPipelineResult(workspaceId, result);

  return {
    ok: true,
    status: result.stage,
    decisionId,
    capabilityKey,
    capabilityTitle: getCapability(capabilityKey)?.title ?? capabilityKey,
    simulated: Boolean(result.execution?.simulated),
    executed: Boolean(result.execution?.executed),
    entity: result.execution?.entity ?? null,
    verified: result.verification?.verified ?? null,
    channelKey: decision.provenance?.channelKey ?? null,
    approvedBy: { id: actor?.id, role: actor?.role },
  };
}

function mapApprovalRow(r) {
  return {
    eventId: r.event_id, approvalId: r.approval_id, action: r.action,
    step: r.step, delegateTo: parse(r.delegate_to_json), occurredAt: r.occurred_at,
  };
}
