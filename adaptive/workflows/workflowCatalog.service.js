import { listCapabilities } from "../capabilities/capabilityRegistry.js";
import { WORKFLOW_STEP_TYPES } from "./workflowValidator.js";

const EVENT_CATALOG = Object.freeze([
  { value: "TASK_CREATED", label: "Task created", category: "Delivery", description: "A task is added to the workspace." },
  { value: "TASK_UPDATED", label: "Task updated", category: "Delivery", description: "A task changes status, owner, due date, or priority." },
  { value: "TASK_COMPLETED", label: "Task completed", category: "Delivery", description: "A task reaches a completed state." },
  { value: "TASK_OVERDUE", label: "Task overdue", category: "Delivery", description: "A task passes its due date while still open." },
  { value: "TASK_BLOCKED", label: "Task blocked", category: "Delivery", description: "A task is marked blocked or stuck." },
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
  { value: "CUSTOMER_ESCALATION", label: "Customer escalation", category: "Customer", description: "A customer issue requires cross-functional follow-through." },
  { value: "INCIDENT_REPORTED", label: "Incident reported", category: "Operations", description: "A production or operational incident is reported." },
  { value: "SECURITY_RISK_DETECTED", label: "Security risk detected", category: "Security", description: "A security/compliance risk needs governed response." },
]);

const CONDITION_FIELDS = Object.freeze([
  { path: "event.eventType", label: "Event type", type: "text", examples: ["TASK_UPDATED", "CUSTOMER_ESCALATION"] },
  { path: "event.metadata.priority", label: "Event priority", type: "text", examples: ["high", "critical"] },
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
        { type: "WHEN", eventTypes: ["TASK_BLOCKED", "TASK_UPDATED"] },
        { type: "IF", path: "event.metadata.priority", operator: "in", value: ["high", "critical"] },
        { type: "APPROVAL", mode: "approval_required" },
        {
          type: "THEN",
          capabilityKey: "notification.send",
          title: "Notify workspace leads",
          summary: "A critical blocked task needs manager attention.",
          input: {
            title: "Blocked work needs review",
            message: "{{event.metadata.title}}",
            projectId: "{{event.metadata.projectId}}",
            taskId: "{{event.metadata.taskId}}",
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
  {
    key: "customer-escalation-response",
    name: "Coordinate customer escalation",
    description: "Create a follow-up task and notify leaders when a customer escalation is recorded.",
    definition: {
      steps: [
        { type: "WHEN", eventTypes: ["CUSTOMER_ESCALATION"] },
        { type: "APPROVAL", mode: "approval_required" },
        {
          type: "THEN",
          capabilityKey: "task.create",
          title: "Create escalation follow-up",
          summary: "Create accountable work from the escalation.",
          input: {
            title: "{{event.metadata.title}}",
            projectId: "{{event.metadata.projectId}}",
            addedBy: "{{event.actorUserId}}",
            assignedTo: "{{event.metadata.ownerId}}",
            priority: "critical",
            description: "{{event.metadata.summary}}",
          },
        },
        {
          type: "THEN",
          capabilityKey: "notification.send",
          title: "Notify escalation stakeholders",
          summary: "Escalation follow-through is ready for stakeholder review.",
          input: {
            title: "Customer escalation follow-up created",
            message: "{{event.metadata.summary}}",
            projectId: "{{event.metadata.projectId}}",
          },
        },
        { type: "END" },
      ],
    },
  },
]);

export function getWorkflowCatalog() {
  const capabilities = listCapabilities()
    .filter((capability) => capability.planning)
    .map((capability) => ({
      value: capability.key,
      label: capability.description,
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
