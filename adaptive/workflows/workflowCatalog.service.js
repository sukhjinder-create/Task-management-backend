import { listCapabilities } from "../capabilities/capabilityRegistry.js";
import { WORKFLOW_STEP_TYPES } from "./workflowValidator.js";

const EVENT_CATALOG = Object.freeze([
  { value: "TASK_CREATED", label: "Task created", category: "Delivery", description: "A task is added to the workspace." },
  { value: "TASK_UPDATED", label: "Task details updated", category: "Delivery", description: "A task changes due date, priority, description, or other details." },
  { value: "TASK_STATUS_CHANGED", label: "Task status changed", category: "Delivery", description: "A task moves to blocked, completed, in progress, or another status." },
  { value: "TASK_ASSIGNED", label: "Task assignment changed", category: "Delivery", description: "A task is assigned or reassigned." },
  { value: "TASK_DELETED", label: "Task deleted", category: "Delivery", description: "A task is removed from the workspace." },
  { value: "PROJECT_CREATED", label: "Project created", category: "Delivery", description: "A project is added to the workspace." },
  { value: "PROJECT_UPDATED", label: "Project updated", category: "Delivery", description: "Project details change." },
  { value: "SPRINT_STARTED", label: "Sprint started", category: "Planning", description: "A sprint begins." },
  { value: "SPRINT_CLOSED", label: "Sprint closed", category: "Planning", description: "A sprint is closed." },
  { value: "MEETING_STARTED", label: "Meeting started", category: "Collaboration", description: "A Huddle/meeting session starts." },
  { value: "MEETING_ENDED", label: "Meeting ended", category: "Collaboration", description: "A Huddle/meeting session ends." },
  { value: "MEETING_INTELLIGENCE_UPDATED", label: "Meeting intelligence ready", category: "Collaboration", description: "Meeting Intelligence produces a digest or outcomes." },
  { value: "EXECUTIVE_SUMMARY_GENERATED", label: "Executive summary generated", category: "Leadership", description: "Executive Summary refreshes operating context." },
  { value: "WORKSPACE_SCORE_CHANGED", label: "Workspace score changed", category: "Leadership", description: "Enterprise intelligence records a score movement." },
  { value: "ATTENDANCE_CHANGED", label: "Attendance changed", category: "People", description: "Attendance or availability materially changes." },
  { value: "LEAVE_APPROVED", label: "Leave approved", category: "People", description: "Approved leave can affect work ownership or capacity." },
  { value: "REVIEW_UPDATED", label: "Review updated", category: "People", description: "A performance/review artifact changes." },
  { value: "GOAL_UPDATED", label: "Goal updated", category: "Goals", description: "An OKR/goal is updated." },
  { value: "KNOWLEDGE_UPDATED", label: "Knowledge updated", category: "Knowledge", description: "Workspace knowledge or wiki content changes." },
]);

const CONDITION_FIELDS = Object.freeze([
  { path: "event.eventType", label: "Event type", type: "text", examples: ["TASK_UPDATED", "TASK_STATUS_CHANGED"] },
  { path: "context.data.task.status", label: "Task status", type: "text", examples: ["blocked", "completed"] },
  { path: "context.data.task.priority", label: "Task priority", type: "text", examples: ["high", "critical"] },
  { path: "context.data.task.assigned_to", label: "Task has an assignee", type: "exists", examples: ["exists"] },
  { path: "event.metadata.riskLevel", label: "Risk level", type: "text", examples: ["medium", "high", "critical"] },
  { path: "context.coverage", label: "Context confidence", type: "number", examples: [0.6, 0.85] },
  { path: "context.data.operationalGraph.relevance.projectId", label: "Related project exists", type: "exists", examples: ["exists"] },
  { path: "context.data.operationalGraph.executiveSummaries.0.summary", label: "Recent executive context exists", type: "exists", examples: ["exists"] },
]);

const TEMPLATES = Object.freeze([
  {
    key: "escalate-blocked-critical-work",
    name: "Escalate blocked critical work",
    description: "When high-risk work is blocked, ask for approval before notifying workspace leads.",
    definition: {
      steps: [
        { type: "WHEN", eventTypes: ["TASK_STATUS_CHANGED", "TASK_UPDATED"] },
        { type: "IF", path: "context.data.task.status", operator: "in", value: ["blocked", "on_hold", "stuck"] },
        { type: "IF", path: "context.data.task.priority", operator: "in", value: ["high", "critical", "urgent"] },
        { type: "APPROVAL", mode: "approval_required" },
        {
          type: "THEN",
          capabilityKey: "notification.send",
          title: "Notify workspace leads",
          summary: "A critical blocked task needs manager attention.",
          input: {
            title: "Blocked work needs review",
            message: "{{context.data.task.task}}",
            projectId: "{{context.data.task.project_id}}",
            taskId: "{{context.data.task.id}}",
          },
        },
        { type: "END" },
      ],
    },
  },
  {
    key: "preserve-meeting-outcomes",
    name: "Preserve meeting outcomes",
    description: "When Meeting Intelligence finishes, save the decision trail into workspace memory after approval.",
    definition: {
      steps: [
        { type: "WHEN", eventTypes: ["MEETING_INTELLIGENCE_UPDATED", "MEETING_ENDED"] },
        { type: "APPROVAL", mode: "approval_required" },
        {
          type: "THEN",
          capabilityKey: "workspace_memory.create",
          title: "Save meeting outcome",
          summary: "Preserve governed meeting outcomes for later reasoning.",
          input: {
            title: "Meeting outcome",
            content: "{{event.metadata.summary}}",
            userId: "{{event.actorUserId}}",
            tags: ["meeting", "decision", "adaptive-runtime"],
          },
        },
        { type: "END" },
      ],
    },
  },
]);

const CAPABILITY_LABELS = Object.freeze({
  "notification.send": "Notify accountable people",
  "task.create": "Create follow-up work",
  "workspace_memory.create": "Save operating memory",
  "autopilot.analyze": "Analyze delivery risk",
  "testing_agent.run_task": "Validate with Testing Agent",
  "executive_summary.generate": "Refresh executive context",
});

export function getWorkflowCatalog() {
  const capabilities = listCapabilities()
    .filter((capability) => capability.planning)
    .map((capability) => ({
      value: capability.key,
      label: CAPABILITY_LABELS[capability.key] || capability.description,
      description: capability.description,
      riskLevel: capability.riskLevel,
      approvalMode: capability.approvalMode,
      intents: capability.planning?.intents || [],
      businessAction: capability.planning?.actionType || null,
      contextTags: capability.planning?.contextTags || [],
    }));
  return {
    stepTypes: WORKFLOW_STEP_TYPES.map((type) => ({
      value: type,
      label: ({
        WHEN: "When this happens",
        IF: "Only if",
        THEN: "Take this action",
        WAIT: "Wait",
        APPROVAL: "Ask for approval",
        END: "Finish",
      })[type] || type,
    })),
    operators: [
      { value: "equals", label: "equals" },
      { value: "not_equals", label: "does not equal" },
      { value: "in", label: "is one of" },
      { value: "not_in", label: "is not one of" },
      { value: "exists", label: "exists" },
      { value: "gt", label: "is greater than" },
      { value: "gte", label: "is at least" },
      { value: "lt", label: "is less than" },
      { value: "lte", label: "is at most" },
    ],
    events: EVENT_CATALOG,
    conditionFields: CONDITION_FIELDS,
    capabilities,
    templates: TEMPLATES,
  };
}
