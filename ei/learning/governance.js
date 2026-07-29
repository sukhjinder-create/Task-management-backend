// ei/learning/governance.js
//
// EI V2.1 Wave C — governance for learning proposals. Reviews are IMMUTABLE, append-only
// decision records; the current review state is resolved from the latest decision. This
// is the data an AI Studio review surface reads — there is NO UI here and NOTHING
// auto-publishes: an "approved" proposal is merely marked ready; actually applying it is
// a separate, deliberate downstream step (out of scope for this wave). Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const REVIEW_DECISIONS = Object.freeze(["approved", "rejected", "deferred"]);

export function createReviewDecision(f) {
  const { workspaceId, proposalId, decision, reviewer = null, note = null, decidedAt, version = 1 } = f || {};
  if (!workspaceId || !proposalId || !REVIEW_DECISIONS.includes(decision) || !decidedAt) return null;
  return deepFreeze({
    decisionId: "ld_" + createHash("sha256").update(JSON.stringify([workspaceId, proposalId, decision, decidedAt, reviewer?.id ?? reviewer ?? null, version])).digest("hex").slice(0, 40),
    eiVersion: "2.1",
    workspaceId: String(workspaceId),
    proposalId,
    decision,
    reviewer,
    note,
    decidedAt,
    version,
    provenance: { engineVersion: "ei-gov-1" },
  });
}

/** Resolve a proposal's current review state from its decisions (latest wins). Pure. */
export function resolveProposalState(proposal, decisions = []) {
  const mine = decisions.filter((d) => d.proposalId === proposal.proposalId)
    .slice().sort((a, b) => new Date(a.decidedAt) - new Date(b.decidedAt) || String(a.decisionId).localeCompare(String(b.decisionId)));
  const latest = mine[mine.length - 1] || null;
  const reviewState = latest ? latest.decision : "pending";
  // "approved" means READY to apply — not applied. Application is a separate step.
  return { proposalId: proposal.proposalId, reviewState, applied: false, latestDecisionId: latest?.decisionId ?? null, decisionCount: mine.length };
}

/** Build the AI-Studio-facing review queue: admissible, still-pending proposals. Pure. */
export function buildReviewQueue(proposals = [], decisions = []) {
  return proposals
    .map((p) => ({ proposal: p, state: resolveProposalState(p, decisions) }))
    .filter((x) => x.proposal.admissible && x.state.reviewState === "pending")
    .sort((a, b) => a.proposal.proposalId.localeCompare(b.proposal.proposalId));
}
