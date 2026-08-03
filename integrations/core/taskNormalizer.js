// integrations/core/taskNormalizer.js
//
// The single place where an external tool's task/issue becomes an Asystence
// task. Every provider — built-in or admin-defined — routes through here.
//
// Before this existed each provider inlined its own mapping, which is why
// priority was silently dropped on every import (both Asana and YouTrack
// hardcoded "medium" regardless of what the source said) and why assignee
// matching behaved differently depending on which tool you imported from.

const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const VALID_TASK_TYPES = new Set(["task", "bug", "feature", "improvement", "chore"]);

// Deliberately generous: these are matched case-insensitively against whatever
// the external tool calls things, so "Highest"/"P1"/"Urgent"/"Critical" all land
// on "high" without the admin configuring anything.
const PRIORITY_SYNONYMS = new Map([
  ["highest", "high"], ["urgent", "high"], ["critical", "high"], ["blocker", "high"],
  ["p0", "high"], ["p1", "high"], ["high", "high"], ["major", "high"], ["show-stopper", "high"],
  ["normal", "medium"], ["medium", "medium"], ["default", "medium"], ["p2", "medium"], ["moderate", "medium"],
  ["low", "low"], ["lowest", "low"], ["minor", "low"], ["trivial", "low"], ["p3", "low"], ["p4", "low"],
]);

const STATUS_SYNONYMS = new Map([
  ["done", "completed"], ["completed", "completed"], ["complete", "completed"],
  ["closed", "completed"], ["resolved", "completed"], ["fixed", "completed"],
  ["shipped", "completed"], ["merged", "completed"],
  ["in progress", "in-progress"], ["in-progress", "in-progress"], ["inprogress", "in-progress"],
  ["started", "in-progress"], ["doing", "in-progress"], ["active", "in-progress"],
  ["in review", "in-progress"], ["review", "in-progress"], ["testing", "in-progress"],
  ["todo", "pending"], ["to do", "pending"], ["to-do", "pending"], ["open", "pending"],
  ["new", "pending"], ["backlog", "backlog"], ["pending", "pending"],
  ["submitted", "pending"], ["triage", "pending"],
]);

const TYPE_SYNONYMS = new Map([
  ["bug", "bug"], ["defect", "bug"], ["problem", "bug"], ["incident", "bug"],
  ["feature", "feature"], ["story", "feature"], ["user story", "feature"], ["epic", "feature"],
  ["enhancement", "improvement"], ["improvement", "improvement"], ["optimization", "improvement"],
  ["chore", "chore"], ["task", "task"], ["subtask", "task"], ["sub-task", "task"],
]);

/** Read "a.b.c" (and "a.0.b") out of a nested object without throwing. */
export function getPath(source, path) {
  if (!path || source == null) return undefined;
  const segments = String(path).split(".").filter(Boolean);
  let cursor = source;
  for (const segment of segments) {
    if (cursor == null) return undefined;
    cursor = Array.isArray(cursor) && /^\d+$/.test(segment)
      ? cursor[Number(segment)]
      : cursor[segment];
  }
  return cursor;
}

function firstDefined(source, paths) {
  for (const path of paths || []) {
    const value = getPath(source, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * External values arrive in wildly different shapes: a plain string ("Done"),
 * an object ({ name: "Done" }), an array of either, or a boolean. Flatten to a
 * comparable string without losing the caller's intent.
 */
function toComparableString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return toComparableString(value[0]);
  if (typeof value === "object") {
    for (const key of ["name", "label", "value", "title", "displayName", "key", "id"]) {
      if (value[key] != null) return toComparableString(value[key]);
    }
  }
  return "";
}

function normalizeEnum(rawValue, { synonyms, allowed, fallback, explicitMap }) {
  const raw = toComparableString(rawValue);
  if (!raw) return fallback;
  const lowered = raw.toLowerCase();

  // An admin's explicit mapping always beats our guesses.
  if (explicitMap) {
    for (const [from, to] of Object.entries(explicitMap)) {
      if (String(from).toLowerCase() === lowered) return to;
    }
  }
  if (allowed?.has(lowered)) return lowered;
  if (synonyms?.has(lowered)) return synonyms.get(lowered);
  return fallback;
}

/** ISO date (YYYY-MM-DD) or null — never an Invalid Date. */
export function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  // Some tools (YouTrack) send epoch milliseconds.
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString().slice(0, 10);
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString().slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const raw = toComparableString(value).toLowerCase();
  return ["true", "yes", "1", "blocked", "on"].includes(raw);
}

function normalizeStoryPoints(value) {
  const raw = toComparableString(value);
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) return null;
  return Math.round(parsed);
}

// Default field locations, tried in order. Covers the common shapes across
// Jira/Asana/YouTrack/Linear/Trello/GitHub-style APIs so a custom provider
// usually needs little or no explicit mapping.
// Jira-family APIs nest everything under `fields.*`, so those variants are
// listed alongside the flat ones for every field.
const DEFAULT_FIELD_PATHS = {
  externalId:  ["id", "gid", "key", "idReadable", "number", "identifier"],
  title:       ["name", "summary", "title", "subject", "fields.summary", "fields.name", "idReadable"],
  description: ["notes", "description", "body", "content", "text", "html_notes",
                "fields.description", "fields.summary"],
  status:      ["status", "state.name", "state", "column", "list.name", "fields.status.name"],
  completed:   ["completed", "resolved", "closed", "isCompleted", "done", "fields.resolution"],
  priority:    ["priority", "priority.name", "fields.priority.name", "severity", "importance"],
  taskType:    ["type", "issueType", "type.name", "fields.issuetype.name", "resource_subtype", "kind"],
  assignee:    ["assignee", "assignee.email", "assignees.0", "fields.assignee.emailAddress",
                "fields.assignee", "owner"],
  dueDate:     ["due_on", "dueDate", "due_at", "duedate", "fields.duedate", "deadline"],
  storyPoints: ["story_points", "storyPoints", "points", "estimate", "fields.customfield_10016"],
  blocked:     ["is_blocked", "blocked", "isBlocked"],
};

/**
 * Turn one raw external task into the exact shape taskRepository.createTask expects.
 *
 * @param {object} raw            The provider's task/issue object, as returned by its API.
 * @param {object} [options]
 * @param {object} [options.fieldMappings]  Admin overrides: { title: "fields.summary", ... }
 * @param {object} [options.valueMappings]  Admin overrides: { status: { "QA": "in-progress" } }
 * @param {Function} [options.resolveAssignee] (rawAssigneeValue) => internalUserId|null
 * @returns {{ externalId: string|null, task: object, unmapped: string[] }}
 */
export function normalizeExternalTask(raw, options = {}) {
  const { fieldMappings = {}, valueMappings = {}, resolveAssignee = null } = options;
  const source = raw || {};

  const pick = (field) => {
    const override = fieldMappings[field];
    if (override) {
      const value = getPath(source, override);
      if (value !== undefined && value !== null && value !== "") return value;
      // An explicit mapping that resolves to nothing is respected as "absent"
      // rather than silently falling back to a guessed path — otherwise an
      // admin's deliberate choice could be overridden by a coincidence.
      return undefined;
    }
    return firstDefined(source, DEFAULT_FIELD_PATHS[field]);
  };

  const rawStatus = pick("status");
  const rawCompleted = pick("completed");
  const unmapped = [];

  // A truthy "completed" flag wins over any status label — a task that the
  // source says is done must never import as pending.
  let status;
  if (rawCompleted !== undefined && normalizeBoolean(rawCompleted)) {
    status = "completed";
  } else {
    status = normalizeEnum(rawStatus, {
      synonyms: STATUS_SYNONYMS,
      allowed: new Set(["pending", "in-progress", "completed", "backlog"]),
      fallback: "pending",
      explicitMap: valueMappings.status,
    });
    if (rawStatus && status === "pending"
        && !STATUS_SYNONYMS.has(toComparableString(rawStatus).toLowerCase())) {
      unmapped.push(`status:${toComparableString(rawStatus)}`);
    }
  }

  const rawPriority = pick("priority");
  const priority = normalizeEnum(rawPriority, {
    synonyms: PRIORITY_SYNONYMS,
    allowed: VALID_PRIORITIES,
    fallback: "medium",
    explicitMap: valueMappings.priority,
  });
  if (rawPriority && priority === "medium"
      && !PRIORITY_SYNONYMS.has(toComparableString(rawPriority).toLowerCase())) {
    unmapped.push(`priority:${toComparableString(rawPriority)}`);
  }

  const taskType = normalizeEnum(pick("taskType"), {
    synonyms: TYPE_SYNONYMS,
    allowed: VALID_TASK_TYPES,
    fallback: "task",
    explicitMap: valueMappings.taskType,
  });

  const title = toComparableString(pick("title")) || "Untitled task";
  const externalIdValue = pick("externalId");

  const rawDescription = pick("description");
  const description = typeof rawDescription === "string"
    ? rawDescription
    : (rawDescription == null ? "" : toComparableString(rawDescription));

  return {
    externalId: externalIdValue == null ? null : String(externalIdValue),
    unmapped,
    task: {
      task: title.slice(0, 500),
      description,
      status,
      priority,
      task_type: taskType,
      due_date: normalizeDate(pick("dueDate")),
      story_points: normalizeStoryPoints(pick("storyPoints")),
      is_blocked: normalizeBoolean(pick("blocked")),
      assigned_to: resolveAssignee ? resolveAssignee(pick("assignee")) : null,
    },
  };
}

/**
 * Shared assignee matching. Every provider previously rolled its own version of
 * this with subtly different rules; this is the union of them — exact email,
 * then username, then email local-part — all case-insensitive.
 *
 * @param {*} rawAssignee   String or object from the provider.
 * @param {Array} users     Workspace users: [{ id, email, username }]
 */
export function matchAssignee(rawAssignee, users = []) {
  if (!rawAssignee || !users.length) return null;

  const candidates = new Set();
  const add = (value) => {
    const text = toComparableString(value).toLowerCase().trim();
    if (text) candidates.add(text);
  };

  if (typeof rawAssignee === "object" && !Array.isArray(rawAssignee)) {
    for (const key of ["email", "emailAddress", "login", "name", "username", "displayName", "fullName"]) {
      add(rawAssignee[key]);
    }
  } else {
    add(rawAssignee);
  }
  if (!candidates.size) return null;

  const byEmail = users.find((u) => u.email && candidates.has(String(u.email).toLowerCase()));
  if (byEmail) return byEmail.id;

  const byUsername = users.find((u) => u.username && candidates.has(String(u.username).toLowerCase()));
  if (byUsername) return byUsername.id;

  const byLocalPart = users.find((u) => {
    const local = String(u.email || "").split("@")[0].toLowerCase();
    return local && candidates.has(local);
  });
  return byLocalPart ? byLocalPart.id : null;
}

export const __testables = {
  toComparableString,
  normalizeEnum,
  normalizeBoolean,
  normalizeStoryPoints,
  PRIORITY_SYNONYMS,
  STATUS_SYNONYMS,
};
