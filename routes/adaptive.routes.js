import express from "express";
import { getRuntimeSettings, updateRuntimeSettings } from "../adaptive/config/runtimeSettings.service.js";
import { listCapabilities } from "../adaptive/capabilities/capabilityRegistry.js";
import { listContextProviders } from "../adaptive/context/contextRegistry.js";
import { replayWorkspaceEvents, retryFailedAdaptiveEvents } from "../adaptive/events/eventQueue.repository.js";
import { recordLearningSignal, listLearningSignals, reverseLearningSignal } from "../adaptive/learning/learningEngine.service.js";
import { getAdaptivePlatformHealth, getExecutionPlan, getRuntimeRun, listAdaptiveRecommendations, listExecutionPlans, listPredictionHistory, listRuntimeRuns } from "../adaptive/observability/observability.service.js";
import { processAdaptiveWorkerBatch } from "../adaptive/runtime/adaptiveWorker.service.js";
import { getWorkflowCatalog } from "../adaptive/workflows/workflowCatalog.service.js";
import { listWorkflowDefinitions, saveWorkflowDefinition, setWorkflowStatus } from "../adaptive/workflows/workflowEngine.service.js";
import {
  approveOperationsAction,
  executeOperationsAction,
  getOperationsActionById,
  rejectOperationsAction,
} from "../services/operationsAction.service.js";

const router = express.Router();

function privileged(role) {
  return ["admin", "owner", "manager"].includes(role);
}

function administrator(role) {
  return ["admin", "owner"].includes(role);
}

function requirePrivileged(req, res, next) {
  if (!privileged(req.user?.role)) return res.status(403).json({ error: "Privileged role required" });
  next();
}

function requireAdministrator(req, res, next) {
  if (!administrator(req.user?.role)) return res.status(403).json({ error: "Administrator role required" });
  next();
}

router.get("/status", async (req, res) => {
  try {
    const settings = await getRuntimeSettings(req.workspaceId);
    const health = await getAdaptivePlatformHealth({ workspaceId: req.workspaceId, settings });
    const publicHealth = privileged(req.user?.role)
      ? health
      : { status: health.status, mode: health.mode, recommendations: health.recommendations };
    res.json(publicHealth);
  } catch (error) {
    res.status(503).json({ status: "unavailable", error: error.message });
  }
});

router.get("/recommendations", async (req, res) => {
  try {
    const recommendations = await listAdaptiveRecommendations({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      role: req.user.role,
      status: req.query.status || "pending",
      limit: req.query.limit,
      projectId: req.query.projectId || null,
      taskId: req.query.taskId || null,
    });
    res.json({ recommendations, count: recommendations.length });
  } catch (error) {
    res.status(500).json({ error: "Failed to load recommendations" });
  }
});

router.post("/recommendations/:id/feedback", async (req, res) => {
  try {
    const feedback = String(req.body?.feedback || "").toLowerCase();
    if (!["ignored", "edited"].includes(feedback)) return res.status(400).json({ error: "feedback must be ignored or edited" });
    const action = await getOperationsActionById({ id: req.params.id, workspaceId: req.workspaceId, userId: req.user.id, role: req.user.role });
    if (!action || action.source !== "adaptive_runtime") return res.status(404).json({ error: "Recommendation not found" });
    const scopeType = action.target_user_id ? "user" : action.project_id ? "project" : "workspace";
    const scopeId = action.target_user_id || action.project_id || null;
    const signal = await recordLearningSignal({
      workspaceId: req.workspaceId,
      scopeType,
      scopeId,
      signalKey: `recommendation.${feedback}`,
      signalValue: { changes: req.body?.changes || null, note: req.body?.note || null },
      source: "recommendation_feedback",
      runtimeRunId: action.adaptive_runtime_run_id,
      actionId: action.id,
      actorUserId: req.user.id,
      idempotencyKey: `action:${action.id}:${feedback}:${req.user.id}`,
    });
    res.json({ success: true, signal });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post("/recommendations/:id/approve", requirePrivileged, async (req, res) => {
  try {
    const action = await approveOperationsAction({
      id: req.params.id, workspaceId: req.workspaceId, actorId: req.user.id,
      role: req.user.role, notes: req.body?.notes || null, execute: req.body?.execute === true,
    });
    res.json({ success: true, action });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/recommendations/:id/reject", requirePrivileged, async (req, res) => {
  try {
    const action = await rejectOperationsAction({
      id: req.params.id, workspaceId: req.workspaceId, actorId: req.user.id,
      role: req.user.role, notes: req.body?.notes || null,
    });
    res.json({ success: true, action });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/recommendations/:id/execute", requirePrivileged, async (req, res) => {
  try {
    const action = await executeOperationsAction({
      id: req.params.id, workspaceId: req.workspaceId, actorId: req.user.id, role: req.user.role,
    });
    res.json({ success: true, action });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/capabilities", requirePrivileged, (_req, res) => {
  res.json({ capabilities: listCapabilities(), contextProviders: listContextProviders() });
});

router.get("/workflow-catalog", requirePrivileged, (_req, res) => {
  res.json(getWorkflowCatalog());
});

router.get("/settings", requirePrivileged, async (req, res) => {
  res.json(await getRuntimeSettings(req.workspaceId));
});

router.put("/settings", requireAdministrator, async (req, res) => {
  try {
    const settings = await updateRuntimeSettings({ workspaceId: req.workspaceId, actorUserId: req.user.id, patch: req.body || {} });
    res.json(settings);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/workflows", requirePrivileged, async (req, res) => {
  const workflows = await listWorkflowDefinitions({ workspaceId: req.workspaceId, includeArchived: req.query.includeArchived === "true" });
  res.json({ workflows });
});

router.post("/workflows", requirePrivileged, async (req, res) => {
  try {
    const workflow = await saveWorkflowDefinition({
      workspaceId: req.workspaceId, actorUserId: req.user.id,
      workflowKey: req.body?.workflowKey, name: req.body?.name,
      description: req.body?.description, definition: req.body?.definition, status: req.body?.status,
    });
    res.status(201).json(workflow);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.patch("/workflows/:id/status", requirePrivileged, async (req, res) => {
  try {
    const workflow = await setWorkflowStatus({ workspaceId: req.workspaceId, workflowId: req.params.id, actorUserId: req.user.id, status: req.body?.status });
    res.json(workflow);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get("/observability/runs", requirePrivileged, async (req, res) => {
  const runs = await listRuntimeRuns({ workspaceId: req.workspaceId, status: req.query.status || null, limit: req.query.limit });
  res.json({ runs });
});

router.get("/observability/runs/:id", requirePrivileged, async (req, res) => {
  const run = await getRuntimeRun({ workspaceId: req.workspaceId, runId: req.params.id });
  if (!run) return res.status(404).json({ error: "Runtime run not found" });
  res.json(run);
});

router.get("/observability/plans", requirePrivileged, async (req, res) => {
  const plans = await listExecutionPlans({ workspaceId: req.workspaceId, status: req.query.status || null, limit: req.query.limit });
  res.json({ plans });
});

router.get("/observability/plans/:id", requirePrivileged, async (req, res) => {
  const plan = await getExecutionPlan({ workspaceId: req.workspaceId, planId: req.params.id });
  if (!plan) return res.status(404).json({ error: "Execution plan not found" });
  res.json(plan);
});

router.get("/observability/predictions", requirePrivileged, async (req, res) => {
  const predictions = await listPredictionHistory({ workspaceId: req.workspaceId, limit: req.query.limit });
  res.json({ predictions });
});

router.get("/learning", requirePrivileged, async (req, res) => {
  const signals = await listLearningSignals({ workspaceId: req.workspaceId, scopeType: req.query.scopeType || null, scopeId: req.query.scopeId || null, limit: req.query.limit });
  res.json({ signals });
});

router.post("/learning/:id/reverse", requireAdministrator, async (req, res) => {
  const signal = await reverseLearningSignal({ workspaceId: req.workspaceId, signalId: req.params.id, actorUserId: req.user.id, reason: req.body?.reason });
  if (!signal) return res.status(404).json({ error: "Active learning signal not found" });
  res.json(signal);
});

router.post("/events/replay", requireAdministrator, async (req, res) => {
  try {
    const result = await replayWorkspaceEvents({ workspaceId: req.workspaceId, eventIds: req.body?.eventIds || [], since: req.body?.since || null, limit: req.body?.limit });
    res.json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/events/dead-letters/retry", requireAdministrator, async (req, res) => {
  try {
    res.json(await retryFailedAdaptiveEvents({ workspaceId: req.workspaceId, limit: req.body?.limit }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/worker/run-once", requireAdministrator, async (req, res) => {
  const result = await processAdaptiveWorkerBatch({ limit: req.body?.limit || 10 });
  res.json(result);
});

export default router;
