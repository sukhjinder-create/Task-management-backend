import { getCapability } from "../capabilities/capabilityRegistry.js";

export const WORKFLOW_STEP_TYPES = Object.freeze(["WHEN", "IF", "THEN", "WAIT", "APPROVAL", "END"]);
const CONDITION_OPERATORS = new Set(["equals", "not_equals", "in", "not_in", "exists", "gt", "gte", "lt", "lte"]);

export function validateWorkflowDefinition(definition) {
  const errors = [];
  const steps = definition?.steps;
  if (!Array.isArray(steps) || steps.length < 2) errors.push("Workflow requires at least WHEN and END steps");
  if (Array.isArray(steps) && steps.length > 20) errors.push("Workflow cannot exceed 20 steps");
  if (steps?.[0]?.type !== "WHEN") errors.push("First workflow step must be WHEN");
  if (steps?.[steps.length - 1]?.type !== "END") errors.push("Last workflow step must be END");

  (steps || []).forEach((step, index) => {
    if (!WORKFLOW_STEP_TYPES.includes(step?.type)) {
      errors.push(`Step ${index + 1} has an unsupported type`);
      return;
    }
    if (step.type === "WHEN" && (!Array.isArray(step.eventTypes) || !step.eventTypes.length)) {
      errors.push(`WHEN step ${index + 1} requires eventTypes`);
    }
    if (step.type === "IF") {
      if (!step.path) errors.push(`IF step ${index + 1} requires path`);
      if (!CONDITION_OPERATORS.has(step.operator)) errors.push(`IF step ${index + 1} has invalid operator`);
    }
    if (step.type === "THEN") {
      if (!step.capabilityKey) errors.push(`THEN step ${index + 1} requires capabilityKey`);
      else if (!getCapability(step.capabilityKey)) errors.push(`THEN step ${index + 1} references an unknown capability`);
    }
    if (step.type === "WAIT") {
      const durationMinutes = Number(step.durationMinutes);
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 43200) {
        errors.push(`WAIT step ${index + 1} must be between 1 minute and 30 days`);
      }
    }
    if (step.type === "APPROVAL" && !["automatic", "approval_required", "manual_only"].includes(step.mode)) {
      errors.push(`APPROVAL step ${index + 1} has invalid mode`);
    }
  });

  return { valid: errors.length === 0, errors };
}
