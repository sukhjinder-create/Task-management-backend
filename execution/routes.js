// execution/routes.js
//
// EWIP V3 — the single Express surface for the execution platform, mounted at
// /execution behind auth + workspace middleware. A guard makes the WHOLE surface inert
// (404) unless the master flag is on for the workspace, so production is unchanged by
// default. Handlers reuse the engines + append-only stores; every mutation flows through
// the capability runtime (side-effect gated). No duplicate engines. UNVERIFIED AT RUNTIME.

import { Router } from "express";
import { isExecutionEnabled, isPolicyEnabled, isAutomationEnabled, isWorkflowEnabled, isAnalyticsEnabled } from "./config.js";
import { listCapabilities, executeCapability } from "./capability.js";
import { createDecisionFromRecommendation, resolveDecisionState, decisionEvent } from "./decision.js";
import { resolveChain, resolveApprovalState, approvalEvent, pendingApprover } from "./approval.js";
import { runDecisionPipeline } from "./pipeline.js";
import { verifyExecution } from "./verification.js";
import { runWorkflow, WORKFLOW_TEMPLATES, validateWorkflow } from "./workflow.js";
import { createPolicy, validatePolicy, evaluatePolicies, resolveEffectivePolicies } from "./policy.js";
import { createAutomation, validateAutomation, matchTriggers } from "./automation.js";
import { actionLogEntry } from "./actionlog.js";
import { computeExecutionAnalytics } from "./analytics.js";
import * as store from "./stores.js";
import { allowRoles } from "../middleware/role.middleware.js";

const router = Router();
const adminOnly = allowRoles("admin"); // mutating / capability-executing endpoints
const wsId = (req) => req.workspaceId || req.headers["x-workspace-id"] || null;
const actorOf = (req) => (req.user ? { type: "user", id: req.user.id, role: req.user.role } : null);
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e?.message || "execution_error" }); } };
const log = (a) => store.appendActionLog(a).catch(() => {});

// Master guard — inert unless enabled for this workspace.
router.use((req, res, next) => {
  if (!isExecutionEnabled(wsId(req))) return res.status(404).json({ error: "execution_platform_disabled" });
  next();
});
// Role floor — the execution platform is admin/manager only (defense in depth; the
// mount also gates roles). Admin-only actions add `adminOnly` per route below.
router.use(allowRoles("admin", "manager"));

// ── Capabilities ──────────────────────────────────────────────────────────────
router.get("/capabilities", wrap(async (req, res) => res.json({ capabilities: listCapabilities() })));
router.post("/capabilities/:key/execute", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const execution = await executeCapability({ workspaceId, key: req.params.key, input: req.body?.input || {}, context: { actorId: req.user?.id, idempotencyKey: req.body?.idempotencyKey } });
  const verification = verifyExecution(execution);
  await store.appendExecution(execution); await store.appendVerification(verification, execution.executionId, workspaceId);
  log(actionLogEntry({ workspaceId, type: "execution", refId: execution.executionId, actor: actorOf(req), payload: { key: req.params.key, status: execution.status } }));
  res.json({ execution, verification });
}));

// ── Decisions ───────────────────────────────────────────────────────────────
router.get("/decisions", wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const decisions = await store.listDecisions({ workspaceId });
  const events = await store.listDecisionEvents({ workspaceId });
  res.json({ decisions: decisions.map((d) => ({ ...d, state: resolveDecisionState({ decisionId: d.decision_id }, events.map(mapEvt)).status })) });
}));
router.post("/decisions", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const decision = createDecisionFromRecommendation({ workspaceId, recommendation: req.body?.recommendation, proposedAction: req.body?.proposedAction });
  if (!decision) return res.status(400).json({ error: "invalid_recommendation" });
  await store.appendDecision(decision);
  const evt = decisionEvent({ decisionId: decision.decisionId, workspaceId, from: "created", to: "created", actor: actorOf(req) });
  await store.appendDecisionEvent(evt);
  log(actionLogEntry({ workspaceId, type: "decision_created", refId: decision.decisionId, actor: actorOf(req), payload: { source: decision.sourceRecommendationId } }));
  res.status(201).json({ decision });
}));
router.get("/decisions/:id", wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const events = (await store.listDecisionEvents({ workspaceId, decisionId: req.params.id })).map(mapEvt);
  const [d] = await store.listDecisions({ workspaceId }).then((rows) => rows.filter((r) => r.decision_id === req.params.id));
  if (!d) return res.status(404).json({ error: "decision_not_found" });
  res.json({ decision: d, state: resolveDecisionState({ decisionId: req.params.id }, events), events });
}));
router.post("/decisions/:id/run", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const [row] = await store.listDecisions({ workspaceId }).then((rows) => rows.filter((r) => r.decision_id === req.params.id));
  if (!row) return res.status(404).json({ error: "decision_not_found" });
  const decision = rowToDecision(row);
  const approvalPolicy = req.body?.approvalPolicy || { mode: "manager" };
  const approval = resolveChain({ decision, policy: approvalPolicy });
  const approvalEvents = (await store.listApprovalEvents({ workspaceId, approvalId: approval.approvalId })).map(mapAppEvt);
  const result = await runDecisionPipeline({ workspaceId, decision, approvalPolicy, approvalEvents, actor: actorOf(req) }, {});
  for (const e of result.events) await store.appendDecisionEvent(e);
  if (result.execution) { await store.appendExecution(result.execution); await store.appendVerification(result.verification, result.execution.executionId, workspaceId); }
  log(actionLogEntry({ workspaceId, type: "decision_transition", refId: decision.decisionId, actor: actorOf(req), payload: { stage: result.stage } }));
  res.json(result);
}));

// ── Approvals ─────────────────────────────────────────────────────────────────
router.get("/approvals", wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const events = (await store.listApprovalEvents({ workspaceId })).map(mapAppEvt);
  res.json({ events });
}));
router.post("/approvals/:approvalId/:action", wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const evt = approvalEvent({ approvalId: req.params.approvalId, workspaceId, action: req.params.action, step: req.body?.step ?? 0, actor: actorOf(req), delegateTo: req.body?.delegateTo || null });
  await store.appendApprovalEvent(evt);
  log(actionLogEntry({ workspaceId, type: "approval_decision", refId: req.params.approvalId, actor: actorOf(req), payload: { action: req.params.action } }));
  res.json({ event: evt });
}));

// ── Workflows ───────────────────────────────────────────────────────────────
router.get("/workflows/templates", wrap(async (req, res) => res.json({ templates: WORKFLOW_TEMPLATES })));
router.post("/workflows/run", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  if (!isWorkflowEnabled(workspaceId)) return res.status(403).json({ error: "workflow_disabled" });
  const definition = req.body?.definition || WORKFLOW_TEMPLATES[req.body?.templateKey];
  const v = validateWorkflow(definition); if (!v.ok) return res.status(400).json({ error: "invalid_workflow", errors: v.errors });
  const run = await runWorkflow({ workspaceId, definition, facts: req.body?.facts || {}, context: { idempotencyKey: req.body?.idempotencyKey } });
  await store.appendWorkflowRun(run);
  log(actionLogEntry({ workspaceId, type: "workflow_run", refId: run.runId, actor: actorOf(req), payload: { status: run.status, workflow: run.workflowKey } }));
  res.json({ run });
}));
router.get("/workflows/runs", wrap(async (req, res) => res.json({ runs: await store.listWorkflowRuns({ workspaceId: wsId(req) }) })));

// ── Policies ────────────────────────────────────────────────────────────────
router.get("/policies", wrap(async (req, res) => res.json({ policies: await store.listPolicies({ workspaceId: wsId(req) }) })));
router.post("/policies", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  if (!isPolicyEnabled(workspaceId)) return res.status(403).json({ error: "policy_disabled" });
  const policy = createPolicy({ ...req.body, workspaceId, scope: req.body?.scope || workspaceId });
  const v = validatePolicy(policy); if (!policy || !v.ok) return res.status(400).json({ error: "invalid_policy", errors: v.errors });
  await store.appendPolicy(policy);
  res.status(201).json({ policy });
}));
router.post("/policies/evaluate", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const platform = (await store.listPolicies({ scope: "PLATFORM" })).map(rowToPolicy);
  const wsPolicies = (await store.listPolicies({ workspaceId })).map(rowToPolicy);
  const effective = resolveEffectivePolicies(platform, wsPolicies);
  res.json({ matches: evaluatePolicies(req.body?.facts || {}, effective) });
}));

// ── Automations ───────────────────────────────────────────────────────────────
router.get("/automations", wrap(async (req, res) => res.json({ automations: await store.listAutomations({ workspaceId: wsId(req) }) })));
router.post("/automations", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  if (!isAutomationEnabled(workspaceId)) return res.status(403).json({ error: "automation_disabled" });
  const automation = createAutomation({ ...req.body, workspaceId });
  const v = validateAutomation(automation); if (!automation || !v.ok) return res.status(400).json({ error: "invalid_automation", errors: v.errors });
  await store.appendAutomation(automation);
  res.status(201).json({ automation });
}));
router.post("/automations/fire", adminOnly, wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const automations = (await store.listAutomations({ workspaceId })).map(rowToAutomation);
  const fired = matchTriggers(req.body?.signal || {}, automations);
  for (const f of fired) log(actionLogEntry({ workspaceId, type: "automation_fired", refId: f.automationId, actor: actorOf(req), payload: { action: f.action } }));
  res.json({ fired });
}));

// ── Action log + analytics + control center ───────────────────────────────────
router.get("/action-log", wrap(async (req, res) => res.json({ actions: await store.listActionLog({ workspaceId: wsId(req), type: req.query.type || null }) })));
router.get("/analytics", wrap(async (req, res) => {
  const workspaceId = wsId(req);
  if (!isAnalyticsEnabled(workspaceId)) return res.status(403).json({ error: "analytics_disabled" });
  const executions = (await store.listExecutions({ workspaceId })).map(rowToExecution);
  const actions = await store.listActionLog({ workspaceId });
  res.json({ analytics: computeExecutionAnalytics({ executions, actions }) });
}));
router.get("/control-center", wrap(async (req, res) => {
  const workspaceId = wsId(req);
  const [decisions, executions, actions] = await Promise.all([store.listDecisions({ workspaceId }), store.listExecutions({ workspaceId }), store.listActionLog({ workspaceId })]);
  res.json({
    overview: { decisions: decisions.length, executions: executions.length, actions: actions.length },
    analytics: computeExecutionAnalytics({ executions: executions.map(rowToExecution), actions }),
  });
}));

// ── row mappers (DB row → engine object) ──────────────────────────────────────
const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; } };
function mapEvt(r) { return { eventId: r.event_id, decisionId: r.decision_id, from: r.from_state, to: r.to_state, occurredAt: r.occurred_at }; }
function mapAppEvt(r) { return { eventId: r.event_id, approvalId: r.approval_id, action: r.action, step: r.step, delegateTo: parse(r.delegate_to_json), occurredAt: r.occurred_at }; }
function rowToDecision(r) { return { decisionId: r.decision_id, workspaceId: r.workspace_id, entity: parse(r.entity_json), proposedAction: parse(r.proposed_action_json), rationaleRefs: parse(r.rationale_refs_json), requiresApproval: r.requires_approval, manualOnly: r.manual_only }; }
function rowToPolicy(r) { return { policyId: r.policy_id, scope: r.scope, workspaceId: r.workspace_id, key: r.key, when: parse(r.when_json), then: parse(r.then_json), version: r.version, lockLevel: r.lock_level, enabled: r.enabled }; }
function rowToAutomation(r) { return { automationId: r.automation_id, workspaceId: r.workspace_id, key: r.key, trigger: parse(r.trigger_json), action: parse(r.action_json), enabled: r.enabled, version: r.version }; }
function rowToExecution(r) { return { executionId: r.execution_id, workspaceId: r.workspace_id, capabilityKey: r.capability_key, status: r.status, ok: r.ok, executed: r.executed, simulated: r.simulated, startedAt: r.started_at, endedAt: r.ended_at }; }

export default router;
