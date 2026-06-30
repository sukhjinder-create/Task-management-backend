import crypto from "node:crypto";
import { stableHash } from "../shared/runtimeUtils.js";

function planStep(base, overrides, plan, stepIndex) {
  return {
    ...base,
    ...overrides,
    ruleKey: `${base.ruleKey}.${overrides.capabilityKey.replace(/[^a-z0-9]+/gi, "_")}`,
    idempotencyKey: `${base.idempotencyKey}:${overrides.capabilityKey}:${stepIndex}`,
    plan: { id: plan.id, objective: plan.objective, stepIndex, totalSteps: plan.totalSteps, dependsOn: overrides.dependsOn || [] },
  };
}

function meetingRecommendations({ event, context }) {
  if (!["MEETING_ENDED", "MEETING_INTELLIGENCE_UPDATED"].includes(event.eventType)) return [];
  const graph = context.data.operationalGraph || {};
  const meeting = graph.meetings?.find((item) => !event.entityId || item.session_id === event.entityId) || graph.meetings?.[0];
  const projectId = graph.relevance?.projectId || event.metadata?.projectId || null;
  const digest = meeting?.digest_json || event.metadata?.digest || event.metadata?.response || {};
  const summary = digest.summary || digest.executiveSummary || event.metadata?.summary || "Recorded meeting outcomes are ready for governed follow-through.";
  const evidence = [{ type: "meeting_outcome", fact: `meeting=${event.entityId || meeting?.session_id || event.eventId}`, source: "huddle.meeting_intelligence", entityId: event.entityId || meeting?.session_id || null }];
  const planId = crypto.randomUUID();
  const common = {
    actorUserId: event.actorUserId || null,
    riskLevel: "medium",
    confidence: meeting ? 0.9 : 0.72,
    ruleConfidence: meeting ? 0.9 : 0.72,
    evidence,
    projectId,
    taskId: null,
  };
  const responseTasks = event.metadata?.response?.tasks;
  const actions = Array.isArray(digest.actionItems) ? digest.actionItems
    : Array.isArray(digest.actions) ? digest.actions
      : Array.isArray(responseTasks) ? responseTasks : [];
  const steps = [
    {
      ...common,
      ruleKey: "meeting_outcome_memory",
      title: "Preserve meeting outcomes",
      summary: "Save the verified meeting outcome to workspace memory.",
      explanation: "A completed Meeting Intelligence digest is available and can be preserved with its source provenance.",
      capabilityKey: "workspace_memory.create",
      actionType: "save_memory_entry",
      idempotencyKey: `adaptive:meeting-memory:${event.entityId || event.eventId}:${stableHash(summary).slice(0, 12)}`,
      input: { title: "Meeting outcome", content: summary, userId: event.actorUserId, tags: ["meeting", "adaptive-runtime"], sourceEntityType: "meeting", sourceEntityId: event.entityId || null },
    },
    {
      ...common,
      ruleKey: "meeting_executive_refresh",
      title: "Refresh executive context",
      summary: "Refresh the Executive Summary with the latest governed meeting outcome.",
      explanation: "The meeting completed after the most recent operational context was assembled.",
      capabilityKey: "executive_summary.generate",
      actionType: "generate_executive_summary",
      approvalMode: "manual_only",
      idempotencyKey: `adaptive:meeting-summary:${event.entityId || event.eventId}`,
      input: { range: "30d" },
    },
    {
      ...common,
      ruleKey: "meeting_stakeholder_notification",
      title: "Share governed meeting outcomes",
      summary: "Notify accountable workspace leads after the outcome plan is approved.",
      explanation: "A completed meeting outcome should reach accountable stakeholders after governance review.",
      capabilityKey: "notification.send",
      actionType: "notify_supervisors",
      idempotencyKey: `adaptive:meeting-notify:${event.entityId || event.eventId}`,
      input: { title: "Meeting outcomes ready", message: summary, projectId },
    },
  ];
  actions.slice(0, 5).forEach((action, index) => {
    if (!projectId || !event.actorUserId || !action?.title) return;
    steps.splice(1 + index, 0, {
      ...common,
      ruleKey: `meeting_action_task_${index}`,
      title: `Create follow-up: ${action.title}`,
      summary: action.description || action.title,
      explanation: "Meeting Intelligence recorded this action item; task creation remains approval governed.",
      capabilityKey: "task.create",
      actionType: "create_followup_task",
      idempotencyKey: `adaptive:meeting-task:${event.entityId || event.eventId}:${index}:${stableHash(action).slice(0, 10)}`,
      input: { title: action.title, projectId, addedBy: event.actorUserId, assignedTo: action.ownerId || null, dueDate: action.dueDate || null, description: action.description || summary, priority: action.priority || "high" },
    });
  });
  return steps.map((item, index) => ({ ...item, plan: { id: planId, objective: "Turn verified meeting outcomes into accountable work", stepIndex: index, totalSteps: steps.length, dependsOn: index ? [index - 1] : [] } }));
}

export function buildExecutionPlan({ event, context, recommendations }) {
  const expanded = [];
  for (const recommendation of recommendations) {
    const plan = {
      id: crypto.randomUUID(),
      objective: recommendation.summary,
      totalSteps: recommendation.riskLevel === "high" && recommendation.projectId ? 2 : 1,
    };
    expanded.push({ ...recommendation, ruleConfidence: recommendation.confidence, plan: { ...plan, stepIndex: 0, dependsOn: [] } });
    if (recommendation.riskLevel === "high" && recommendation.projectId) {
      expanded.push(planStep(recommendation, {
        title: `Analyze root cause: ${context.data.task?.display_id || context.data.task?.task || "delivery risk"}`,
        summary: "Use the existing Autopilot engine to analyze this project after approval.",
        explanation: `${recommendation.explanation} The recorded high-risk condition warrants project-level alternative analysis.`,
        capabilityKey: "autopilot.analyze",
        actionType: "run_autopilot",
        approvalMode: "manual_only",
        input: { projectId: recommendation.projectId },
        dependsOn: [0],
      }, plan, 1));
    }
  }
  expanded.push(...meetingRecommendations({ event, context }));
  return expanded;
}
