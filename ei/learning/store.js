// ei/learning/store.js
//
// EI V2.1 Wave C — immutable learning-proposal + review-decision store. Append-only,
// idempotent by proposal_id / decision_id. Nothing is ever updated in place — a review
// is a new decision row. Schema-tolerant. UNVERIFIED AT RUNTIME.

import { q } from "../../ai-platform/studio/db.js";

export async function appendProposal(p) {
  if (!p || !p.proposalId || !p.workspaceId) return null;
  const { rows } = await q(
    `INSERT INTO ei_learning_proposals
       (proposal_id, workspace_id, kind, target, current_value_json, proposed_value_json,
        rationale_refs_json, evidence_json, cleanliness_json, admissible, status, version, provenance_json, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (proposal_id) DO NOTHING
     RETURNING proposal_id`,
    [
      p.proposalId, p.workspaceId, p.kind, p.target, JSON.stringify(p.currentValue ?? null), JSON.stringify(p.proposedValue ?? null),
      JSON.stringify(p.rationaleRefs || {}), JSON.stringify(p.evidence || {}), JSON.stringify(p.cleanliness || {}),
      Boolean(p.admissible), p.status, p.version || 1, JSON.stringify(p.provenance || {}), p.schemaVersion || 1,
    ]
  );
  return rows[0]?.proposal_id ?? null;
}

export async function appendReviewDecision(d) {
  if (!d || !d.decisionId || !d.proposalId) return null;
  const { rows } = await q(
    `INSERT INTO ei_learning_reviews
       (decision_id, workspace_id, proposal_id, decision, reviewer_json, note, decided_at, version, provenance_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (decision_id) DO NOTHING
     RETURNING decision_id`,
    [d.decisionId, d.workspaceId, d.proposalId, d.decision, JSON.stringify(d.reviewer ?? null), d.note ?? null, d.decidedAt, d.version || 1, JSON.stringify(d.provenance || {})]
  );
  return rows[0]?.decision_id ?? null;
}

export async function listProposals({ workspaceId, status = null, limit = 300 } = {}) {
  const { rows } = await q(
    `SELECT * FROM ei_learning_proposals WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY proposal_id LIMIT $3`,
    [workspaceId, status, Math.min(Number(limit) || 300, 1000)]
  );
  return rows;
}

export async function listReviewDecisions({ workspaceId, limit = 500 } = {}) {
  const { rows } = await q(`SELECT * FROM ei_learning_reviews WHERE workspace_id = $1 ORDER BY decided_at, decision_id LIMIT $2`, [workspaceId, Math.min(Number(limit) || 500, 2000)]);
  return rows;
}
