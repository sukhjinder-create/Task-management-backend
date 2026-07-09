// execution/stores.js
//
// EWIP V3 — schema-tolerant, append-only persistence for the execution substrate.
// Every writer is idempotent by its deterministic id and never updates in place
// (lifecycle changes are new event rows). Reuses the AI Platform q. UNVERIFIED AT
// RUNTIME (needs a migrated database); no-ops without one.

import { q } from "./lib.js";
const J = (v) => JSON.stringify(v ?? null);

// ── Decisions ─────────────────────────────────────────────────────────────────
export async function appendDecision(d) {
  if (!d?.decisionId) return null;
  const { rows } = await q(
    `INSERT INTO exec_decisions (decision_id, workspace_id, source_recommendation_id, entity_json, proposed_action_json, rationale_refs_json, requires_approval, manual_only, created_at, provenance_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (decision_id) DO NOTHING RETURNING decision_id`,
    [d.decisionId, d.workspaceId, d.sourceRecommendationId, J(d.entity), J(d.proposedAction), J(d.rationaleRefs), Boolean(d.requiresApproval), Boolean(d.manualOnly), d.createdAt, J(d.provenance)]
  );
  return rows[0]?.decision_id ?? null;
}
export async function appendDecisionEvent(e) {
  if (!e?.eventId) return null;
  const { rows } = await q(
    `INSERT INTO exec_decision_events (event_id, decision_id, workspace_id, from_state, to_state, actor_json, ref, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [e.eventId, e.decisionId, e.workspaceId, e.from, e.to, J(e.actor), e.ref, e.occurredAt]
  );
  return rows[0]?.event_id ?? null;
}
export async function listDecisions({ workspaceId, limit = 200 } = {}) {
  const { rows } = await q(`SELECT * FROM exec_decisions WHERE workspace_id = $1 ORDER BY created_at DESC, decision_id LIMIT $2`, [workspaceId, Math.min(Number(limit) || 200, 1000)]);
  return rows;
}
export async function listDecisionEvents({ workspaceId, decisionId = null } = {}) {
  const { rows } = await q(`SELECT * FROM exec_decision_events WHERE workspace_id = $1 AND ($2::text IS NULL OR decision_id = $2) ORDER BY occurred_at, event_id`, [workspaceId, decisionId]);
  return rows;
}

// ── Approvals ─────────────────────────────────────────────────────────────────
export async function appendApprovalRequest(r) {
  if (!r?.approvalId) return null;
  const { rows } = await q(
    `INSERT INTO exec_approval_requests (approval_id, decision_id, workspace_id, mode, steps_json, on_timeout, timeout_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (approval_id) DO NOTHING RETURNING approval_id`,
    [r.approvalId, r.decisionId, r.workspaceId, r.mode, J(r.steps), r.onTimeout, r.timeoutAt, r.createdAt]
  );
  return rows[0]?.approval_id ?? null;
}
export async function appendApprovalEvent(e) {
  if (!e?.eventId) return null;
  const { rows } = await q(
    `INSERT INTO exec_approval_events (event_id, approval_id, workspace_id, action, step, actor_json, delegate_to_json, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [e.eventId, e.approvalId, e.workspaceId, e.action, e.step, J(e.actor), J(e.delegateTo), e.occurredAt]
  );
  return rows[0]?.event_id ?? null;
}
export async function listApprovalEvents({ workspaceId, approvalId = null } = {}) {
  const { rows } = await q(`SELECT * FROM exec_approval_events WHERE workspace_id = $1 AND ($2::text IS NULL OR approval_id = $2) ORDER BY occurred_at, event_id`, [workspaceId, approvalId]);
  return rows;
}

// ── Executions + verifications ────────────────────────────────────────────────
export async function appendExecution(x) {
  if (!x?.executionId) return null;
  const { rows } = await q(
    `INSERT INTO exec_executions (execution_id, workspace_id, capability_key, capability_version, status, ok, executed, simulated, output_json, failure_reason, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (execution_id) DO NOTHING RETURNING execution_id`,
    [x.executionId, x.workspaceId, x.capabilityKey, x.capabilityVersion, x.status, Boolean(x.ok), Boolean(x.executed), Boolean(x.simulated), J(x.output), x.failureReason ?? null, x.startedAt, x.endedAt]
  );
  return rows[0]?.execution_id ?? null;
}
export async function appendVerification(v, executionId, workspaceId) {
  if (!executionId) return null;
  const { rows } = await q(
    `INSERT INTO exec_verifications (execution_id, workspace_id, verified, mode, evidence_json, failure_reason, references_json, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now()) ON CONFLICT (execution_id) DO NOTHING RETURNING execution_id`,
    [executionId, workspaceId, Boolean(v.verified), v.mode, J(v.evidence), v.failureReason ?? null, J(v.references)]
  );
  return rows[0]?.execution_id ?? null;
}
export async function listExecutions({ workspaceId, limit = 200 } = {}) {
  const { rows } = await q(`SELECT * FROM exec_executions WHERE workspace_id = $1 ORDER BY started_at DESC, execution_id LIMIT $2`, [workspaceId, Math.min(Number(limit) || 200, 1000)]);
  return rows;
}

// ── Workflow runs ─────────────────────────────────────────────────────────────
export async function appendWorkflowRun(w) {
  if (!w?.runId) return null;
  const { rows } = await q(
    `INSERT INTO exec_workflow_runs (run_id, workspace_id, workflow_key, workflow_version, status, steps_json, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
    [w.runId, w.workspaceId, w.workflowKey, w.workflowVersion, w.status, J(w.steps), w.startedAt, w.endedAt]
  );
  return rows[0]?.run_id ?? null;
}
export async function listWorkflowRuns({ workspaceId, limit = 200 } = {}) {
  const { rows } = await q(`SELECT * FROM exec_workflow_runs WHERE workspace_id = $1 ORDER BY started_at DESC, run_id LIMIT $2`, [workspaceId, Math.min(Number(limit) || 200, 1000)]);
  return rows;
}

// ── Policies + automations (versioned, append-only) ───────────────────────────
export async function appendPolicy(p) {
  if (!p?.policyId) return null;
  const { rows } = await q(
    `INSERT INTO exec_policies (policy_id, scope, workspace_id, key, when_json, then_json, version, lock_level, enabled, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (policy_id) DO NOTHING RETURNING policy_id`,
    [p.policyId, p.scope, p.workspaceId, p.key, J(p.when), J(p.then), p.version, p.lockLevel, Boolean(p.enabled), p.createdAt]
  );
  return rows[0]?.policy_id ?? null;
}
export async function listPolicies({ workspaceId = null, scope = null, limit = 500 } = {}) {
  const { rows } = await q(`SELECT * FROM exec_policies WHERE ($1::text IS NULL OR scope = $1) AND ($2::text IS NULL OR workspace_id = $2) ORDER BY key, version DESC LIMIT $3`, [scope, workspaceId, Math.min(Number(limit) || 500, 2000)]);
  return rows;
}
export async function appendAutomation(a) {
  if (!a?.automationId) return null;
  const { rows } = await q(
    `INSERT INTO exec_automations (automation_id, workspace_id, key, trigger_json, action_json, enabled, version, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (automation_id) DO NOTHING RETURNING automation_id`,
    [a.automationId, a.workspaceId, a.key, J(a.trigger), J(a.action), Boolean(a.enabled), a.version, a.createdAt]
  );
  return rows[0]?.automation_id ?? null;
}
export async function listAutomations({ workspaceId, limit = 500 } = {}) {
  const { rows } = await q(`SELECT * FROM exec_automations WHERE workspace_id = $1 ORDER BY key, version DESC LIMIT $2`, [workspaceId, Math.min(Number(limit) || 500, 2000)]);
  return rows;
}

// ── Enterprise action log ─────────────────────────────────────────────────────
export async function appendActionLog(a) {
  if (!a?.actionId) return null;
  const { rows } = await q(
    `INSERT INTO exec_action_log (action_id, workspace_id, type, ref_id, actor_json, payload_json, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (action_id) DO NOTHING RETURNING action_id`,
    [a.actionId, a.workspaceId, a.type, a.refId, J(a.actor), J(a.payload), a.occurredAt]
  );
  return rows[0]?.action_id ?? null;
}
export async function listActionLog({ workspaceId, type = null, limit = 500 } = {}) {
  const { rows } = await q(`SELECT * FROM exec_action_log WHERE workspace_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY occurred_at DESC, action_id LIMIT $3`, [workspaceId, type, Math.min(Number(limit) || 500, 2000)]);
  return rows;
}
