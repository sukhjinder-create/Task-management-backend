// ei/learning/service.js
//
// EI V2.1 Wave C — orchestration for the learning engine + governance. Deterministic,
// flag-gated, additive. Generates proposals from verified outcomes (never mutating
// anything) and exposes the AI-Studio-facing review queue. Reviews append immutable
// decisions; nothing auto-publishes.

import { generateProposals } from "./engine.js";
import { validateLearningProposal } from "./proposal.js";
import { createReviewDecision, buildReviewQueue, resolveProposalState } from "./governance.js";
import { appendProposal, appendReviewDecision } from "./store.js";
import { isEiLearningEnabled } from "../config/flags.js";

/** Generate + persist learning proposals (candidates only). @param {object} [deps] */
export async function proposeLearning({ workspaceId, recommendations = [], predictions = [], outcomes = [], validation = null, effectiveness = null, experiments = [], decisions = [] } = {}, deps = {}) {
  if (!isEiLearningEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendProposal || appendProposal;

  const proposals = generateProposals({ workspaceId, recommendations, predictions, outcomes, validation, effectiveness, experiments });
  let written = 0;
  for (const p of proposals) {
    // Persist candidates for auditability; only admissible ones are valid for approval.
    const id = await append(p);
    if (id) written += 1;
  }
  const admissibleValid = proposals.filter((p) => p.admissible && validateLearningProposal(p).ok);
  return {
    workspaceId: String(workspaceId),
    eiVersion: "2.1",
    proposed: proposals.length,
    written,
    admissible: admissibleValid.length,
    blockedConfounded: proposals.filter((p) => !p.admissible).length,
    reviewQueue: buildReviewQueue(proposals, decisions),
    proposals,
  };
}

/** Record an immutable review decision (approve/reject/defer). Nothing auto-publishes. */
export async function reviewLearningProposal({ workspaceId, proposal, proposalId, decision, reviewer = null, note = null, decidedAt, decisions = [] } = {}, deps = {}) {
  if (!isEiLearningEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendReviewDecision || appendReviewDecision;
  const rec = createReviewDecision({ workspaceId, proposalId: proposalId || proposal?.proposalId, decision, reviewer, note, decidedAt });
  if (!rec) return { reviewed: false, reason: "invalid_decision" };
  const id = await append(rec);
  const state = proposal ? resolveProposalState(proposal, [...decisions, rec]) : { proposalId: rec.proposalId, reviewState: decision, applied: false };
  return { reviewed: true, written: Boolean(id), decision: rec, state };
}
