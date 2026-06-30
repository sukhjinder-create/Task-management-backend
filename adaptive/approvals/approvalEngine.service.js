import { getCapability } from "../capabilities/capabilityRegistry.js";
import { createRecommendationPrediction } from "../evaluation/evaluationEngine.service.js";
import { recordProposedInvocation, executeCapability } from "../execution/executionEngine.service.js";
import { recommendationAcceptancePrior } from "../personalization/personalizationEngine.service.js";
import {
  approveOperationsAction,
  createOperationsAction,
  executeOperationsAction,
  findOperationsActionByIdempotencyKey,
} from "../../services/operationsAction.service.js";
import pool from "../../db.js";

async function persistPlanStep({ event, runtimeRunId, recommendation, action }) {
  const plan = recommendation.plan;
  if (!plan?.id) return;
  await pool.query(
    `INSERT INTO adaptive_execution_plans
      (id, workspace_id, runtime_run_id, event_id, objective, total_steps, status)
     VALUES ($1,$2,$3,$4,$5,$6,'approval_pending')
     ON CONFLICT (id) DO UPDATE SET total_steps = GREATEST(adaptive_execution_plans.total_steps, EXCLUDED.total_steps), updated_at = NOW()`,
    [plan.id, event.workspaceId, runtimeRunId, event.eventId, plan.objective, plan.totalSteps || 1]
  );
  await pool.query(
    `INSERT INTO adaptive_execution_plan_steps
      (workspace_id, plan_id, step_index, capability_key, action_id, depends_on, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'approval_pending')
     ON CONFLICT (plan_id, step_index) DO UPDATE SET action_id = EXCLUDED.action_id, updated_at = NOW()`,
    [event.workspaceId, plan.id, plan.stepIndex || 0, recommendation.capabilityKey, action.id, JSON.stringify(plan.dependsOn || [])]
  );
}

export async function resolveApprovalPolicy({ recommendation, capability, settings }) {
  const configured = recommendation.approvalMode || capability.approvalMode || settings.default_approval_mode;
  if (configured === "manual_only" || capability.approvalMode === "manual_only") return "manual_only";
  if (settings.mode !== "auto") return "approval_required";
  if (!capability.autoEligible || ["high", "critical"].includes(recommendation.riskLevel)) {
    return "approval_required";
  }
  return configured === "automatic" || settings.default_approval_mode === "automatic"
    ? "automatic"
    : "approval_required";
}

function operationsPayload(recommendation) {
  const adaptiveMetadata = {
    confidenceModel: recommendation.confidenceModel || null,
    personalization: recommendation.personalization || null,
    policyExplanation: recommendation.policyExplanation || null,
    plan: recommendation.plan || null,
  };
  if (recommendation.actionType === "create_followup_task") {
    return {
      projectId: recommendation.projectId,
      taskTitle: recommendation.input?.title,
      assignedTo: recommendation.input?.assignedTo || null,
      dueDate: recommendation.input?.dueDate || null,
      description: recommendation.input?.description || recommendation.summary,
      priority: recommendation.input?.priority || "high",
      ...adaptiveMetadata,
    };
  }
  if (recommendation.actionType === "save_memory_entry") {
    return { ...(recommendation.input || {}), ...adaptiveMetadata };
  }
  if (recommendation.capabilityKey !== "notification.send") {
    return { ...(recommendation.input || {}), ...adaptiveMetadata };
  }
  return {
    message: recommendation.input?.message || recommendation.summary,
    title: recommendation.input?.title || recommendation.title,
    metadata: { capabilityKey: recommendation.capabilityKey, ruleKey: recommendation.ruleKey },
    ...adaptiveMetadata,
  };
}

export async function routeRecommendation({ recommendation, event, runtimeRunId, settings }) {
  const capability = getCapability(recommendation.capabilityKey);
  if (!capability) throw new Error(`Recommendation selected unknown capability: ${recommendation.capabilityKey}`);
  const approvalMode = await resolveApprovalPolicy({ recommendation, capability, settings });

  const existing = await findOperationsActionByIdempotencyKey({
    workspaceId: event.workspaceId,
    idempotencyKey: recommendation.idempotencyKey,
    confidenceModel: recommendation.confidenceModel || {},
    personalization: recommendation.personalization || {},
    executionPlanId: recommendation.plan?.id || null,
  });

  await persistPlanStep({ event, runtimeRunId, recommendation, action });
  if (existing) return { action: existing, approvalMode, duplicate: true };

  const prior = await recommendationAcceptancePrior({
    workspaceId: event.workspaceId,
    userId: recommendation.targetUserId || event.actorUserId || null,
    projectId: recommendation.projectId || null,
  });
  const action = await createOperationsAction({
    workspaceId: event.workspaceId,
    source: "adaptive_runtime",
    roleScope: recommendation.targetUserId ? "user" : recommendation.projectId ? "project" : "workspace",
    title: recommendation.title,
    summary: recommendation.summary,
    explanation: `${recommendation.explanation} Adaptive policy: ${recommendation.policyExplanation || prior.explanation}`,
    confidence: recommendation.confidence,
    riskLevel: recommendation.riskLevel,
    actionType: recommendation.actionType,
    createdBy: event.actorUserId || null,
    targetUserId: recommendation.targetUserId || null,
    projectId: recommendation.projectId || null,
    taskId: recommendation.taskId || null,
    payload: operationsPayload(recommendation),
    evidence: recommendation.evidence || [],
    generatedBy: "adaptive_reasoning_v1",
    adaptiveRuntimeRunId: runtimeRunId,
    capabilityKey: recommendation.capabilityKey,
    approvalMode,
    correlationId: event.correlationId || null,
    idempotencyKey: recommendation.idempotencyKey,
  });

  await recordProposedInvocation({
    workspaceId: event.workspaceId,
    runtimeRunId,
    capability,
    approvalMode,
    idempotencyKey: recommendation.idempotencyKey,
    input: recommendation.input,
    actorUserId: event.actorUserId,
  });
  await createRecommendationPrediction({
    workspaceId: event.workspaceId,
    runtimeRunId,
    eventId: event.eventId,
    action,
    actorUserId: recommendation.targetUserId || event.actorUserId,
    evidence: recommendation.evidence,
  });

  if (approvalMode === "automatic") {
    await approveOperationsAction({
      id: action.id,
      workspaceId: event.workspaceId,
      actorId: event.actorUserId || null,
      role: "admin",
      notes: "Automatically approved by workspace adaptive policy",
      execute: false,
    });
    const executed = await executeOperationsAction({
      id: action.id,
      workspaceId: event.workspaceId,
      actorId: event.actorUserId || null,
      role: "admin",
    });
    return { action: executed, approvalMode, duplicate: false };
  }

  return { action, approvalMode, duplicate: false };
}

export async function executeWorkflowCapability({
  capabilityKey,
  input,
  event,
  runtimeRunId,
  settings,
  approvalMode,
  idempotencyKey,
}) {
  return executeCapability({
    workspaceId: event.workspaceId,
    runtimeRunId,
    capabilityKey,
    input,
    actor: { userId: event.actorUserId, role: event.metadata?.actorRole || "user" },
    settings,
    approvalMode,
    idempotencyKey,
  });
}
