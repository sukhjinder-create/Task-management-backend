// execution/agentPolicy.js
//
// WHICH AGENT ACTIONS NEED A HUMAN — the approval line for AI-proposed decisions.
//
// This is a PRODUCT judgement, so it lives here as declarative data with a stated
// rationale, not as branch logic scattered through the agent. Get it wrong in
// either direction and the feature fails: approve everything and you have added
// friction to a product whose point is removing it; approve nothing and the
// audit trail is theatre around an ungated agent.
//
// The line drawn here is BLAST RADIUS:
//   • auto      — affects only the requester or creates something new and
//                 reversible. Nothing existing is altered, nobody else's work
//                 changes, nothing leaves the workspace.
//   • manager   — alters work that ALREADY EXISTS or belongs to someone else.
//                 Reversible, but somebody other than the requester feels it.
//   • admin     — fans out to many people or escalates beyond the team.
//
// These are DEFAULTS, not law. A workspace policy row for the same key overrides
// them through the existing policy engine (resolveEffectivePolicies), which is
// exactly what PolicyStudio edits — so admins can move the line without a deploy.
// A platform policy marked global_locked cannot be overridden, which is how a
// compliance-sensitive tenant gets pinned.

import { deepFreeze } from "./lib.js";

export const AGENT_APPROVAL_MODES = Object.freeze(["auto", "manager", "admin", "executive"]);

/**
 * capabilityKey → { mode, why }
 * `why` is surfaced to the user in chat, so the agent can always explain itself.
 */
export const AGENT_ACTION_POLICY = deepFreeze({
  "work.task.create": {
    mode: "auto",
    why: "Creating a task adds new work without changing anything that already exists, and it can be archived.",
  },
  "work.team.notify": {
    mode: "auto",
    why: "A single notification to one person is low impact and cannot be acted on without them choosing to.",
  },
  "work.task.assign": {
    mode: "manager",
    why: "Assigning work changes what someone else is expected to do, so a manager confirms it.",
  },
  "work.task.update": {
    mode: "manager",
    why: "Editing an existing task changes a record other people rely on.",
  },
  "work.task.priority": {
    mode: "manager",
    why: "Re-prioritising reorders someone else's queue.",
  },
  "work.risk.escalate": {
    mode: "admin",
    why: "Escalation notifies leadership and changes how a project is perceived, so an admin signs off.",
  },
});

/** Anything not listed is treated as needing an admin — fail CLOSED, never open. */
export const DEFAULT_UNKNOWN_POLICY = deepFreeze({
  mode: "admin",
  why: "This action is not in the agent's approved catalogue, so it needs an admin to review it.",
});

/**
 * Resolve the approval mode for an agent-proposed capability.
 *
 * @param {string} capabilityKey
 * @param {object} [options]
 * @param {Array}  [options.policyMatches]  matches from evaluatePolicies(), which win
 * @param {boolean} [options.sideEffectsEnabled] when false everything is a dry run
 * @returns {{mode: string, why: string, source: string}}
 */
export function resolveAgentApproval(capabilityKey, { policyMatches = [], sideEffectsEnabled = true } = {}) {
  // A configured workspace/platform policy for this capability always wins.
  const override = policyMatches.find(
    (match) => match?.action === capabilityKey || match?.params?.capabilityKey === capabilityKey
  );
  if (override?.params?.approvalMode && AGENT_APPROVAL_MODES.includes(override.params.approvalMode)) {
    return {
      mode: override.params.approvalMode,
      why: override.params.why || `Set by policy "${override.key}".`,
      source: `policy:${override.policyId}`,
    };
  }

  const base = AGENT_ACTION_POLICY[capabilityKey] || DEFAULT_UNKNOWN_POLICY;

  // In dry-run mode nothing mutates, so gating adds friction for no safety gain.
  // The decision, approval chain and action log are still recorded in full.
  if (!sideEffectsEnabled) {
    return { mode: "auto", why: `${base.why} (Dry run — no live change is made.)`, source: "dry_run" };
  }

  return { ...base, source: AGENT_ACTION_POLICY[capabilityKey] ? "default" : "default:unknown" };
}

/** The approval policy object the pipeline expects. */
export function toApprovalPolicy(mode, { timeoutMs = 0, onTimeout = "escalate" } = {}) {
  return {
    mode: AGENT_APPROVAL_MODES.includes(mode) ? mode : "manager",
    ...(timeoutMs ? { timeoutMs } : {}),
    onTimeout,
  };
}
