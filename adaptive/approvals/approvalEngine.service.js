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
  if (recommendation.actionType === "create_followup_task") {
    return {
      projectId: recommendation.projectId,
      taskTitle: recommendation.input?.title,
      assignedTo: recommendation.input?.assignedTo || null,
      dueDate: recommendation.input?.dueDate || null,
      description: recommendation.input?.description || recommendation.summary,
      priority: recommendation.input?.priority || "high",
    };
  }
  if (recommendation.actionType === "save_memory_entry") {
    return recommendation.input || {};
  }
  return {
    message: recommendation.input?.message || recommendation.summary,
    title: recommendation.input?.title || recommendation.title,
    metadata: { capabilityKey: recommendation.capabilityKey, ruleKey: recommendation.ruleKey },
  };
}

export async function routeRecommendation({ recommendation, event, runtimeRunId, settings }) {
  const capability = getCapability(recommendation.capabilityKey);
  if (!capability) throw new Error(`Recommendation selected unknown capability: ${recommendation.capabilityKey}`);
  const approvalMode = await resolveApprovalPolicy({ recommendation, capability, settings });

  const existing = await findOperationsActionByIdempotencyKey({
    workspaceId: event.workspaceId,
    idempotencyKey: recommendation.idempotencyKey,
  });
  if (existing) return { action: existing, approvalMode, duplicate: true };

  const prior = await recommendationAcceptancePrior({
    workspaceId: event.workspaceId,
    userId: recommendation.targetUserId || event.actorUserId || null,
  });
  const action = await createOperationsAction({
    workspaceId: event.workspaceId,
    source: "adaptive_runtime",
    roleScope: recommendation.targetUserId ? "user" : recommendation.projectId ? "project" : "workspace",
    title: recommendation.title,
    summary: recommendation.summary,
    explanation: `${recommendation.explanation} Personalization: ${prior.explanation}`,
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
