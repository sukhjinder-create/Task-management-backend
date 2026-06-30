import { clamp, stableHash } from "../shared/runtimeUtils.js";

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function taskIsComplete(task) {
  return ["completed", "done", "closed"].includes(normalizeStatus(task?.status));
}

function taskIsBlocked(task) {
  return ["blocked", "on_hold", "stuck"].includes(normalizeStatus(task?.status));
}

function taskIsOverdue(task, now) {
  if (!task?.due_date || taskIsComplete(task)) return false;
  const due = new Date(task.due_date);
  return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
}

function evidence(type, fact, source, entityId = null) {
  return { type, fact, source, entityId };
}

function taskRecommendationBase({ event, context, ruleKey, title, summary, explanation, confidence, riskLevel }) {
  const task = context.data.task;
  const idempotencyKey = `adaptive:${ruleKey}:${task.id}:${stableHash({ status: task.status, dueDate: task.due_date, assignedTo: task.assigned_to }).slice(0, 16)}`;
  return {
    ruleKey,
    title,
    summary,
    explanation,
    confidence: clamp(confidence * Math.max(context.coverage, 0.5), 0, 0.99),
    riskLevel,
    capabilityKey: "notification.send",
    actionType: "notify_supervisors",
    targetUserId: task.assigned_to || null,
    projectId: task.project_id || null,
    taskId: task.id,
    actorUserId: event.actorUserId || null,
    idempotencyKey,
  };
}

function reasonAboutTask({ event, context, now }) {
  const task = context.data.task;
  if (!task) return [];
  const recommendations = [];
  const taskLabel = task.display_id || task.task || "task";

  if (taskIsOverdue(task, now)) {
    const days = Math.max(1, Math.floor((now.getTime() - new Date(task.due_date).getTime()) / 86400000));
    recommendations.push({
      ...taskRecommendationBase({
        event,
        context,
        ruleKey: "overdue_task_review",
        title: `Review overdue task: ${taskLabel}`,
        summary: `${task.task || "This task"} is incomplete and ${days} day(s) past its due date.`,
        explanation: "The recommendation is based on the current task status and due date from the task service. No external assumptions were used.",
        confidence: 0.93,
        riskLevel: days >= 7 ? "high" : "medium",
      }),
      input: {
        title: "Overdue delivery risk",
        message: `${task.task || "Task"} is ${days} day(s) overdue and needs an owner decision.`,
        taskId: task.id,
        projectId: task.project_id,
      },
      evidence: [
        evidence("task_status", `status=${task.status}`, "task.service", task.id),
        evidence("task_due_date", `due_date=${task.due_date}`, "task.service", task.id),
      ],
    });
  }

  if (taskIsBlocked(task)) {
    recommendations.push({
      ...taskRecommendationBase({
        event,
        context,
        ruleKey: "blocked_task_escalation",
        title: `Resolve blocker: ${taskLabel}`,
        summary: `${task.task || "This task"} is currently blocked and may affect delivery.`,
        explanation: "The current task status is explicitly blocked. The runtime recommends review; it does not infer an unrecorded blocker cause.",
        confidence: 0.9,
        riskLevel: "high",
      }),
      input: {
        title: "Blocked task requires review",
        message: `${task.task || "Task"} is blocked. Review the recorded blocker and agree the next action.`,
        taskId: task.id,
        projectId: task.project_id,
      },
      evidence: [evidence("task_status", `status=${task.status}`, "task.service", task.id)],
    });
  }

  const highPriority = ["high", "urgent", "critical"].includes(normalizeStatus(task.priority));
  if (!task.assigned_to && !taskIsComplete(task) && highPriority) {
    recommendations.push({
      ...taskRecommendationBase({
        event,
        context,
        ruleKey: "unassigned_priority_task",
        title: `Assign an owner: ${taskLabel}`,
        summary: `${task.task || "This priority task"} has no recorded assignee.`,
        explanation: "The task is active, high priority, and has no assignee in the task service record.",
        confidence: 0.96,
        riskLevel: "medium",
      }),
      input: {
        title: "Priority task needs an owner",
        message: `${task.task || "A priority task"} has no assignee. Assign an accountable owner.`,
        taskId: task.id,
        projectId: task.project_id,
      },
      evidence: [
        evidence("task_priority", `priority=${task.priority}`, "task.service", task.id),
        evidence("task_assignment", "assigned_to=null", "task.service", task.id),
      ],
    });
  }

  return recommendations;
}

function reasonAboutWorkspaceSignal({ event, context }) {
  if (event.eventType !== "WORKSPACE_SCORE_CHANGED") return [];
  const delta = Number(event.metadata?.delta);
  if (!Number.isFinite(delta) || delta > -5) return [];
  const commandCenter = context.data.commandCenter;
  return [{
    ruleKey: "workspace_score_drop",
    title: "Review workspace delivery posture",
    summary: `The canonical workspace score decreased by ${Math.abs(delta).toFixed(1)} points.`,
    explanation: "This recommendation is triggered only by a recorded score delta from canonical enterprise intelligence.",
    confidence: clamp(Number(context.data.workspaceIntelligence?.confidence || 0.8), 0.5, 0.98),
    riskLevel: delta <= -10 ? "high" : "medium",
    capabilityKey: "notification.send",
    actionType: "notify_supervisors",
    projectId: null,
    taskId: null,
    actorUserId: event.actorUserId || null,
    idempotencyKey: `adaptive:workspace_score_drop:${event.workspaceId}:${event.eventId}`,
    input: {
      title: "Workspace delivery posture changed",
      message: commandCenter?.narrative || `Workspace score decreased by ${Math.abs(delta).toFixed(1)} points. Review the evidence and priorities.`,
    },
    evidence: [evidence("workspace_score_delta", `delta=${delta}`, "enterprise_intelligence")],
  }];
}

export function reasonFromOperationalContext({ event, context, now = new Date() }) {
  const recommendations = [
    ...reasonAboutTask({ event, context, now }),
    ...reasonAboutWorkspaceSignal({ event, context }),
  ];
  const evidence = recommendations.flatMap((item) => item.evidence || []);
  return {
    recommendations,
    evidence,
    summary: recommendations.length
      ? `${recommendations.length} evidence-backed recommendation(s) produced from ${context.sources.filter((source) => source.status === "available").length} available context source(s).`
      : `No actionable recommendation met the deterministic evidence threshold for ${event.eventType}.`,
    model: "deterministic_operational_reasoner_v1",
    explainable: true,
  };
}
