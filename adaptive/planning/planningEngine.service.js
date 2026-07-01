import crypto from "node:crypto";
import { listPlannableCapabilities } from "../capabilities/capabilityRegistry.js";
import { stableHash } from "../shared/runtimeUtils.js";

function actorRole(event) {
  return event.metadata?.actorRole || "user";
}

function strategyProfile(context) {
  const profiles = context.data.operationalGraph?.behaviourProfiles || [];
  return profiles.find((profile) => profile.profile_key === "adaptive_strategy" && Number(profile.sample_count || 0) >= 3)
    || profiles.find((profile) => profile.profile_key === "adaptive_strategy")
    || null;
}

function candidateScore({ capability, recommendation, context, event, intent }) {
  if (!capability.allowedRoles.includes(actorRole(event))) return -Infinity;
  const input = capability.planning.buildInput?.({ recommendation, context, event }) || recommendation.input || {};
  try { capability.validate(input); } catch { return -Infinity; }

  const graph = context.data.operationalGraph || {};
  const tags = new Set(recommendation.contextTags || []);
  const tagMatches = (capability.planning.contextTags || []).filter((tag) => tags.has(tag)).length;
  let score = Number(capability.planning.businessValue || 0.5) + (tagMatches * 0.08);
  if (intent === "refresh_executive" && (graph.executiveSummaries?.length || graph.goals?.some((goal) => goal.status === "at_risk"))) score += 0.18;
  if (capability.key === "autopilot.analyze" && (graph.dependencies?.length || graph.riskHistory?.length >= 3)) score += 0.15;
  if (capability.key === "testing_agent.run_task" && tags.has("security")) score += 0.22;
  if (capability.key === "workspace_memory.create" && graph.meetings?.length) score += 0.12;

  const strategy = strategyProfile(context)?.profile_value || {};
  if ((strategy.preferredCapabilities || []).includes(capability.key)) score += 0.3;
  if ((strategy.avoidedCapabilities || []).includes(capability.key)) score -= 0.45;
  return score;
}

function selectCapability({ intent, recommendation, context, event }) {
  const candidates = listPlannableCapabilities()
    .filter((capability) => capability.planning.intents.includes(intent))
    .map((capability) => ({ capability, score: candidateScore({ capability, recommendation, context, event, intent }) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.capability.planning.sequence - right.capability.planning.sequence);
  const selected = candidates[0];
  if (!selected) return null;
  return {
    capability: selected.capability,
    score: selected.score,
    alternatives: candidates.slice(1, 4).map((candidate) => ({ key: candidate.capability.key, score: candidate.score })),
  };
}

function plannedStep({ recommendation, intent, context, event, plan, stepIndex, dependsOn = [] }) {
  const selected = selectCapability({ intent, recommendation, context, event });
  if (!selected) return null;
  const capability = selected.capability;
  const input = capability.planning.buildInput?.({ recommendation, context, event }) || recommendation.input || {};
  return {
    ...recommendation,
    ruleKey: `${recommendation.ruleKey}.${capability.key.replace(/[^a-z0-9]+/gi, "_")}`,
    title: recommendation.stepTitles?.[intent] || recommendation.title,
    capabilityKey: capability.key,
    actionType: capability.planning.actionType,
    approvalMode: recommendation.approvalMode || capability.approvalMode,
    input,
    idempotencyKey: `${recommendation.idempotencyKey}:${capability.key}:${stepIndex}`,
    planningDecision: {
      intent,
      selectedCapability: capability.key,
      selectionScore: Math.round(selected.score * 1000) / 1000,
      alternatives: selected.alternatives,
      registryDriven: true,
    },
    plan: { ...plan, stepIndex, dependsOn },
  };
}

function taskPlan({ event, context, recommendation }) {
  const desired = new Set(recommendation.desiredIntents || ["notify"]);
  if (recommendation.riskLevel === "high" || recommendation.riskLevel === "critical") desired.add("analyze_risk");
  for (const intent of recommendation.contextualIntents || []) desired.add(intent);
  const selected = [];
  for (const intent of desired) {
    const preview = selectCapability({ intent, recommendation, context, event });
    if (preview && !selected.some((item) => item.intent === intent || item.capabilityKey === preview.capability.key)) {
      selected.push({ intent, capabilityKey: preview.capability.key, sequence: preview.capability.planning.sequence });
    }
  }
  selected.sort((a, b) => a.sequence - b.sequence);
  const plan = {
    id: crypto.randomUUID(),
    objective: recommendation.summary,
    totalSteps: selected.length,
    strategy: "registry_ranked_contextual_v1",
  };
  return selected.map((item, index) => plannedStep({
    recommendation, intent: item.intent, context, event, plan, stepIndex: index,
    dependsOn: index ? [index - 1] : [],
  })).filter(Boolean);
}

function meetingPlan({ event, context }) {
  if (!["MEETING_ENDED", "MEETING_INTELLIGENCE_UPDATED"].includes(event.eventType)) return [];
  const graph = context.data.operationalGraph || {};
  const meeting = graph.meetings?.find((item) => !event.entityId || item.session_id === event.entityId) || graph.meetings?.[0];
  const projectId = graph.relevance?.projectId || event.metadata?.projectId || null;
  const digest = meeting?.digest_json || event.metadata?.digest || event.metadata?.response || {};
  const summary = digest.summary || digest.executiveSummary || event.metadata?.summary || "Recorded meeting outcomes are ready for governed follow-through.";
  const actions = Array.isArray(digest.actionItems) ? digest.actionItems
    : Array.isArray(digest.actions) ? digest.actions
      : Array.isArray(event.metadata?.response?.tasks) ? event.metadata.response.tasks : [];
  const evidence = [{ type: "meeting_outcome", fact: `meeting=${event.entityId || meeting?.session_id || event.eventId}`, source: "huddle.meeting_intelligence", entityId: event.entityId || meeting?.session_id || null }];
  const common = {
    actorUserId: event.actorUserId || null, riskLevel: "medium", confidence: meeting ? 0.9 : 0.72,
    ruleConfidence: meeting ? 0.9 : 0.72, evidence, projectId, taskId: null,
    contextTags: ["meeting", "decision", "executive", "stakeholder"],
  };
  const semanticSteps = [
    {
      ...common, intent: "preserve_knowledge", ruleKey: "meeting_outcome_memory",
      title: "Preserve meeting outcomes", summary: "Save the verified meeting outcome to workspace memory.",
      explanation: "A completed Meeting Intelligence digest is available with source provenance.",
      memoryTitle: "Meeting outcome", memoryContent: summary,
      idempotencyKey: `adaptive:meeting-memory:${event.entityId || event.eventId}:${stableHash(summary).slice(0, 12)}`,
    },
    ...actions.slice(0, 5).filter((action) => projectId && event.actorUserId && action?.title).map((action, index) => ({
      ...common, intent: "create_work", ruleKey: `meeting_action_task_${index}`,
      title: `Create follow-up: ${action.title}`, followupTitle: action.title,
      summary: action.description || action.title,
      explanation: "Meeting Intelligence recorded this action item; creation remains approval governed.",
      targetUserId: action.ownerId || null,
      adjustedPriority: action.priority || "high",
      input: { title: action.title, assignedTo: action.ownerId || null, dueDate: action.dueDate || null, description: action.description || summary },
      idempotencyKey: `adaptive:meeting-task:${event.entityId || event.eventId}:${index}:${stableHash(action).slice(0, 10)}`,
    })),
    {
      ...common, intent: "refresh_executive", ruleKey: "meeting_executive_refresh",
      title: "Refresh executive context", summary: "Refresh the Executive Summary with the latest governed meeting outcome.",
      explanation: "The meeting completed after the most recent executive context was assembled.",
      approvalMode: "manual_only", input: { range: "30d" },
      idempotencyKey: `adaptive:meeting-summary:${event.entityId || event.eventId}`,
    },
    {
      ...common, intent: "notify", ruleKey: "meeting_stakeholder_notification",
      title: "Share governed meeting outcomes", summary: "Notify accountable workspace leads after the outcome plan is approved.",
      explanation: "Verified meeting outcomes should reach accountable stakeholders after governance review.",
      input: { title: "Meeting outcomes ready", message: summary, projectId },
      idempotencyKey: `adaptive:meeting-notify:${event.entityId || event.eventId}`,
    },
  ];
  const plan = {
    id: crypto.randomUUID(), objective: "Turn verified meeting outcomes into accountable work",
    totalSteps: semanticSteps.length, strategy: "registry_ranked_meeting_v1",
  };
  return semanticSteps.map((recommendation, index) => plannedStep({
    recommendation, intent: recommendation.intent, context, event, plan, stepIndex: index,
    dependsOn: index ? [index - 1] : [],
  })).filter(Boolean).map((item, index, items) => ({ ...item, plan: { ...item.plan, stepIndex: index, totalSteps: items.length, dependsOn: index ? [index - 1] : [] } }));
}

export function buildExecutionPlan({ event, context, recommendations }) {
  return [
    ...recommendations.flatMap((recommendation) => taskPlan({ event, context, recommendation })),
    ...meetingPlan({ event, context }),
  ];
}
