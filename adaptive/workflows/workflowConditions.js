import { getPath } from "../shared/runtimeUtils.js";

function comparableEquals(actual, expected) {
  if (typeof actual === "number" || typeof expected === "number") {
    const left = Number(actual);
    const right = Number(expected);
    if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
  }
  return actual === expected;
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* accept a business-friendly comma-separated list */ }
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

export function workflowConditionMatches(step, context) {
  const actual = getPath(context, step.path);
  switch (step.operator) {
    case "equals": return comparableEquals(actual, step.value);
    case "not_equals": return !comparableEquals(actual, step.value);
    case "in": return listValue(step.value).some((value) => comparableEquals(actual, value));
    case "not_in": return !listValue(step.value).some((value) => comparableEquals(actual, value));
    case "exists": return step.value === false ? actual == null : actual != null;
    case "gt": return Number(actual) > Number(step.value);
    case "gte": return Number(actual) >= Number(step.value);
    case "lt": return Number(actual) < Number(step.value);
    case "lte": return Number(actual) <= Number(step.value);
    default: return false;
  }
}
