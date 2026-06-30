import { isUuid } from "../shared/runtimeUtils.js";

const CONTRACTS = [
  ["TASK_CREATED", "task"], ["TASK_UPDATED", "task"], ["TASK_STATUS_CHANGED", "task"],
  ["TASK_ASSIGNED", "task"], ["TASK_COMPLETED", "task"], ["TASK_DELETED", "task"],
  ["PROJECT_CREATED", "project"], ["PROJECT_UPDATED", "project"],
  ["PROJECT_STATUS_CHANGED", "project"], ["PROJECT_ARCHIVED", "project"],
  ["SPRINT_STARTED", "sprint"], ["SPRINT_CLOSED", "sprint"],
  ["ATTENDANCE_CHANGED", "attendance"], ["LEAVE_REQUESTED", "leave"],
  ["LEAVE_APPROVED", "leave"], ["LEAVE_REJECTED", "leave"],
  ["MEETING_STARTED", "meeting"], ["MEETING_ENDED", "meeting"],
  ["MEETING_INTELLIGENCE_UPDATED", "meeting"],
  ["EXECUTIVE_SUMMARY_GENERATED", "executive_summary"],
  ["WORKSPACE_INTELLIGENCE_UPDATED", "workspace_intelligence"],
  ["WORKSPACE_SCORE_CHANGED", "workspace_intelligence"],
  ["REVIEW_SUBMITTED", "review"], ["REVIEW_UPDATED", "review"],
  ["GOAL_UPDATED", "goal"], ["KNOWLEDGE_UPDATED", "knowledge"],
  ["CUSTOMER_ESCALATED", "customer"],
  ["NOTIFICATION_ACKNOWLEDGED", "notification"],
  ["TESTING_AGENT_RUN_REQUESTED", "testing_run"],
  ["AUTOPILOT_RUN_REQUESTED", "autopilot"],
  ["OPERATIONS_ACTION_DECIDED", "operations_action"],
];

export const DOMAIN_EVENT_CONTRACTS = Object.freeze(Object.fromEntries(
  CONTRACTS.map(([eventType, entityType]) => [eventType, Object.freeze({ eventType, entityType, schemaVersion: 1 })])
));

export function getDomainEventContract(eventType) {
  return DOMAIN_EVENT_CONTRACTS[String(eventType || "").toUpperCase()] || null;
}

export function validateDomainEvent(event, { allowUnknown = true } = {}) {
  const errors = [];
  const contract = getDomainEventContract(event?.eventType);
  if (!event?.workspaceId || !isUuid(event.workspaceId)) errors.push("workspaceId must be a UUID");
  if (!event?.eventType) errors.push("eventType is required");
  if (!event?.entityType) errors.push("entityType is required");
  if (!Number.isInteger(Number(event?.schemaVersion)) || Number(event.schemaVersion) < 1) {
    errors.push("schemaVersion must be a positive integer");
  }
  if (!contract && !allowUnknown) errors.push(`Unknown domain event: ${event?.eventType}`);
  if (contract && event?.entityType !== contract.entityType) {
    errors.push(`${contract.eventType} requires entityType=${contract.entityType}`);
  }
  if (contract && Number(event?.schemaVersion) > contract.schemaVersion) {
    errors.push(`${contract.eventType} schema version ${event.schemaVersion} is not supported`);
  }
  return { valid: errors.length === 0, errors, contract };
}

export function assertDomainEvent(event, options) {
  const validation = validateDomainEvent(event, options);
  if (!validation.valid) {
    const error = new Error(`Invalid domain event: ${validation.errors.join("; ")}`);
    error.code = "INVALID_DOMAIN_EVENT";
    error.details = validation.errors;
    throw error;
  }
  return event;
}
