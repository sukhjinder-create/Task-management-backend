import { clamp, stableHash } from "../shared/runtimeUtils.js";
import { buildExecutionPlan } from "../planning/planningEngine.service.js";

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

function contextualInfluence(task, graph) {
  const goalsAtRisk = (graph.goals || []).filter((goal) => ["at_risk", "off_track", "blocked"].includes(normalizeStatus(goal.status)) || Number(goal.progress) < 40);
  const reviewConcerns = (graph.reviews || []).filter((review) => review.status !== "submitted" || Number(review.overall_score || 5) < 3);
  const attendance = graph.availability?.attendance || [];
  const averageAvailability = attendance.length
    ? attendance.reduce((sum, row) => sum + Number(row.available_minutes || 0), 0) / attendance.length
    : null;
  const workload = (graph.workload || []).find((row) => String(row.user_id) === String(task?.assigned_to)) || null;
  const rejectedOutcomes = (graph.previousOutcomes || []).filter((signal) => signal.signal_key === "recommendation.rejected");
  const executiveRisk = (graph.executiveSummaries || []).some((summary) => /critical|risk|overdue|blocked|escalat/i.test(`${summary.summary || ""} ${JSON.stringify(summary.source_data || {})}`));
  const titleWords = String(task?.task || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 5);
  const relevantKnowledge = (graph.knowledge || []).filter((page) => titleWords.some((word) => String(page.title || "").toLowerCase().includes(word)));
  const contextEvidence = [];
  let riskDelta = 0;
  if (goalsAtRisk.length) { riskDelta += Math.min(0.15, goalsAtRisk.length * 0.04); contextEvidence.push(evidence("business_priority", `${goalsAtRisk.length} at-risk goal(s)`, "okr_objectives")); }
  if (reviewConcerns.length) { riskDelta += Math.min(0.08, reviewConcerns.length * 0.02); contextEvidence.push(evidence("review_signal", `${reviewConcerns.length} review concern(s)`, "performance_reviews")); }
  if (averageAvailability != null && averageAvailability < 300) { riskDelta += 0.12; contextEvidence.push(evidence("attendance_capacity", `average_available_minutes=${Math.round(averageAvailability)}`, "attendance_daily")); }
  if (Number(workload?.active_tasks || 0) >= 8 || Number(workload?.overdue_tasks || 0) >= 3) { riskDelta += 0.12; contextEvidence.push(evidence("workload_pressure", `active=${workload?.active_tasks || 0},overdue=${workload?.overdue_tasks || 0}`, "tasks")); }
  if (executiveRisk) { riskDelta += 0.1; contextEvidence.push(evidence("executive_priority", "recent executive context contains recorded operational risk", "executive_summary")); }
  if ((graph.riskHistory || []).length >= 5) { riskDelta += 0.08; contextEvidence.push(evidence("risk_history", `${graph.riskHistory.length} related historical event(s)`, "workspace_events")); }
  if (relevantKnowledge.length) contextEvidence.push(evidence("knowledge_match", `${relevantKnowledge.length} relevant knowledge article(s)`, "wiki_pages"));
  if ((graph.meetings || []).length) contextEvidence.push(evidence("meeting_history", `${graph.meetings.length} recent meeting digest(s)`, "huddle_meeting_digests"));
  if (rejectedOutcomes.length) contextEvidence.push(evidence("manager_behaviour", `${rejectedOutcomes.length} previous rejection signal(s)`, "adaptive_learning_signals"));

  const text = `${task?.task || ""} ${task?.description || ""}`.toLowerCase();
  const contextualIntents = [];
  const contextTags = [];
  if (/security|production|release|incident|compliance|audit/.test(text)) { contextualIntents.push("validate"); contextTags.push("security", "release"); }
  if (executiveRisk || goalsAtRisk.length) { contextualIntents.push("refresh_executive"); contextTags.push("executive", "business_priority"); }
  if ((graph.riskHistory || []).length >= 5 && relevantKnowledge.length === 0) { contextualIntents.push("preserve_knowledge"); contextTags.push("history", "knowledge"); }
  return {
    riskDelta: Math.min(riskDelta, 0.45),
    evidence: contextEvidence,
    contextualIntents,
    contextTags,
    recommendedTiming: riskDelta >= 0.25 ? "immediate" : rejectedOutcomes.length >= 3 ? "next_digest" : "next_business_hour",
    approvalSuggestion: riskDelta >= 0.25 ? "approval_required" : "policy_default",
    adjustedPriority: riskDelta >= 0.25 ? "critical" : riskDelta >= 0.12 ? "high" : task?.priority,
    summary: {
      goalsAtRisk: goalsAtRisk.length, reviewConcerns: reviewConcerns.length,
      averageAvailability: averageAvailability == null ? null : Math.round(averageAvailability),
      workload: workload ? { active: Number(workload.active_tasks), overdue: Number(workload.overdue_tasks), blocked: Number(workload.blocked_tasks) } : null,
      executiveRisk, relevantKnowledge: relevantKnowledge.length, rejectedOutcomes: rejectedOutcomes.length,
    },
  };
}

function taskRecommendationBase({ event, context, influence, ruleKey, title, summary, explanation, confidence, riskLevel }) {
  const task = context.data.task;
  const idempotencyKey = `adaptive:${ruleKey}:${task.id}:${stableHash({ status: task.status, dueDate: task.due_date, assignedTo: task.assigned_to }).slice(0, 16)}`;
  return {
    ruleKey,
    title,
    summary,
    explanation,
    confidence: clamp((confidence * Math.max(context.coverage, 0.5)) + influence.riskDelta * 0.15, 0, 0.99),
    riskLevel: influence.riskDelta >= 0.25 && riskLevel === "high" ? "critical"
      : influence.riskDelta >= 0.12 && riskLevel === "medium" ? "high" : riskLevel,
    desiredIntents: ["notify"],
    contextualIntents: influence.contextualIntents,
    contextTags: influence.contextTags,
    contextInfluence: influence.summary,
    recommendedTiming: influence.recommendedTiming,
    approvalSuggestion: influence.approvalSuggestion,
    adjustedPriority: influence.adjustedPriority,
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
  const graph = context.data.operationalGraph || {};
  const influence = contextualInfluence(task, graph);
  const blockingLinks = (graph.dependencies || []).filter((link) => ["blocks", "is_blocked_by"].includes(link.link_type));
  const activeLeave = graph.availability?.leave || [];

  if (taskIsOverdue(task, now)) {
    const days = Math.max(1, Math.floor((now.getTime() - new Date(task.due_date).getTime()) / 86400000));
    recommendations.push({
      ...taskRecommendationBase({
        event, context, influence,
        ruleKey: "overdue_task_review",
        title: `Review overdue task: ${taskLabel}`,
        summary: `${task.task || "This task"} is incomplete and ${days} day(s) past its due date.`,
        explanation: `The recommendation uses the recorded task status and due date${blockingLinks.length ? `, plus ${blockingLinks.length} recorded dependency link(s)` : ""}${activeLeave.length ? ", the assignee's approved leave window" : ""}${influence.evidence.length ? `, and ${influence.evidence.length} verified enterprise context signal(s)` : ""}. No external assumptions were used.`,
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
        ...blockingLinks.slice(0, 3).map((link) => evidence("task_dependency", `${link.link_type}:${link.source_title}->${link.target_title}`, "task_links", link.id)),
        ...activeLeave.slice(0, 1).map((leave) => evidence("assignee_availability", `approved_leave=${leave.start_date}..${leave.end_date}`, "leave.service", leave.id)),
        ...influence.evidence,
      ],
    });
  }

  if (taskIsBlocked(task)) {
    recommendations.push({
      ...taskRecommendationBase({
        event, context, influence,
        ruleKey: "blocked_task_escalation",
        title: `Resolve blocker: ${taskLabel}`,
        summary: `${task.task || "This task"} is currently blocked and may affect delivery.`,
        explanation: blockingLinks.length
          ? `The task is explicitly blocked and ${blockingLinks.length} recorded dependency link(s) identify the verified delivery chain.`
          : "The current task status is explicitly blocked. The runtime recommends review; it does not infer an unrecorded blocker cause.",
        confidence: 0.9,
        riskLevel: "high",
      }),
      input: {
        title: "Blocked task requires review",
        message: `${task.task || "Task"} is blocked. Review the recorded blocker and agree the next action.`,
        taskId: task.id,
        projectId: task.project_id,
      },
      evidence: [
        evidence("task_status", `status=${task.status}`, "task.service", task.id),
        ...blockingLinks.slice(0, 3).map((link) => evidence("task_dependency", `${link.link_type}:${link.source_title}->${link.target_title}`, "task_links", link.id)),
        ...influence.evidence,
      ],
    });
  }

  const highPriority = ["high", "urgent", "critical"].includes(normalizeStatus(task.priority));
  if (!task.assigned_to && !taskIsComplete(task) && highPriority) {
    recommendations.push({
      ...taskRecommendationBase({
        event, context, influence,
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
        ...influence.evidence,
      ],
    });
  }

  return recommendations;
}

function reasonAboutOperationalSignal({ event, context }) {
  const graph = context.data.operationalGraph || {};
  const definitions = {
    LEAVE_APPROVED: { title: "Rebalance work for approved leave", intents: ["analyze_risk", "notify"], risk: "medium", tags: ["capacity", "people"] },
    ATTENDANCE_CHANGED: { title: "Review material availability change", intents: ["analyze_risk"], risk: "medium", tags: ["capacity", "people"] },
    GOAL_UPDATED: { title: "Align delivery with the updated goal", intents: ["analyze_risk", "refresh_executive"], risk: "high", tags: ["business_priority", "executive"] },
    REVIEW_UPDATED: { title: "Preserve the governed review outcome", intents: ["preserve_knowledge", "notify"], risk: "medium", tags: ["people", "knowledge"] },
    KNOWLEDGE_UPDATED: { title: "Apply updated operating knowledge", intents: ["notify"], risk: "low", tags: ["knowledge"] },
    EXECUTIVE_SUMMARY_GENERATED: { title: "Align operating work with executive priorities", intents: ["analyze_risk"], risk: "high", tags: ["executive", "business_priority"] },
    CUSTOMER_ESCALATION: { title: "Coordinate the customer escalation", intents: ["create_work", "analyze_risk", "refresh_executive", "notify"], risk: "critical", tags: ["customer", "executive", "risk"] },
    INCIDENT_REPORTED: { title: "Coordinate incident response", intents: ["create_work", "analyze_risk", "validate", "notify"], risk: "critical", tags: ["incident", "security", "risk"] },
    SECURITY_RISK_DETECTED: { title: "Coordinate security-risk response", intents: ["create_work", "validate", "refresh_executive", "notify"], risk: "critical", tags: ["security", "executive", "risk"] },
  };
  const definition = definitions[event.eventType];
  if (!definition) return [];
  const projectId = graph.relevance?.projectId || event.metadata?.projectId || null;
  const factualSummary = event.metadata?.summary || event.metadata?.title || `${event.eventType} was recorded in the workspace event stream.`;
  return [{
    ruleKey: `operational_signal_${event.eventType.toLowerCase()}`,
    title: definition.title,
    summary: factualSummary,
    explanation: `The ${event.eventType} event is recorded and the plan is constrained to registered capabilities, current permissions, and approval policy.`,
    confidence: clamp(0.72 + Math.min((graph.executiveSummaries?.length || 0) * 0.02, 0.1), 0, 0.95),
    riskLevel: definition.risk,
    desiredIntents: definition.intents,
    contextualIntents: [],
    contextTags: definition.tags,
    projectId,
    taskId: event.metadata?.taskId || null,
    targetUserId: event.metadata?.userId || null,
    actorUserId: event.actorUserId || null,
    adjustedPriority: definition.risk === "critical" ? "critical" : "high",
    recommendedTiming: definition.risk === "critical" ? "immediate" : "next_business_hour",
    approvalSuggestion: "approval_required",
    idempotencyKey: `adaptive:${event.eventType.toLowerCase()}:${event.workspaceId}:${event.eventId}`,
    input: { title: definition.title, message: factualSummary, description: factualSummary },
    evidence: [evidence("operational_event", `event_type=${event.eventType}`, "workspace_events", event.eventId)],
  }];
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
  const baseRecommendations = [
    ...reasonAboutTask({ event, context, now }),
    ...reasonAboutWorkspaceSignal({ event, context }),
    ...reasonAboutOperationalSignal({ event, context }),
  ];
  const recommendations = buildExecutionPlan({ event, context, recommendations: baseRecommendations });
  const evidence = recommendations.flatMap((item) => item.evidence || []);
  return {
    recommendations,
    evidence,
    summary: recommendations.length
      ? `${recommendations.length} evidence-backed recommendation(s) produced from ${context.sources.filter((source) => source.status === "available").length} available context source(s).`
      : `No actionable recommendation met the deterministic evidence threshold for ${event.eventType}.`,
    model: "evidence_constrained_operational_planner_v2",
    explainable: true,
  };
}
