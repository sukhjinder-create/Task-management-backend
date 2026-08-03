import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExternalTask,
  matchAssignee,
  normalizeDate,
  getPath,
} from "../integrations/core/taskNormalizer.js";
import {
  listBuiltInProviders,
  customProviderKey,
  customProviderSlug,
  isCustomProvider,
  describeCustomProvider,
} from "../integrations/core/providerCapabilities.js";

test("preserves external priority instead of flattening everything to medium", () => {
  // This is the regression the shared normalizer exists to fix: both the Asana
  // and YouTrack importers previously hardcoded priority to "medium".
  assert.equal(normalizeExternalTask({ name: "a", priority: "Highest" }).task.priority, "high");
  assert.equal(normalizeExternalTask({ name: "a", priority: "Urgent" }).task.priority, "high");
  assert.equal(normalizeExternalTask({ name: "a", priority: { name: "P1" } }).task.priority, "high");
  assert.equal(normalizeExternalTask({ name: "a", priority: "Trivial" }).task.priority, "low");
  assert.equal(normalizeExternalTask({ name: "a", priority: "Normal" }).task.priority, "medium");
  // Unknown values degrade to medium rather than importing something invalid.
  assert.equal(normalizeExternalTask({ name: "a", priority: "Wibble" }).task.priority, "medium");
  // ...but are reported so the admin can map them explicitly.
  assert.ok(normalizeExternalTask({ name: "a", priority: "Wibble" }).unmapped.includes("priority:Wibble"));
});

test("a source that says the task is done never imports as pending", () => {
  // Asana signals completion with a boolean, not a status string.
  assert.equal(normalizeExternalTask({ name: "a", completed: true }).task.status, "completed");
  // The boolean must win even when a stale status label disagrees.
  assert.equal(
    normalizeExternalTask({ name: "a", completed: true, status: "In Progress" }).task.status,
    "completed"
  );
  assert.equal(normalizeExternalTask({ name: "a", status: "Done" }).task.status, "completed");
  assert.equal(normalizeExternalTask({ name: "a", status: "In Review" }).task.status, "in-progress");
  assert.equal(normalizeExternalTask({ name: "a", status: "Backlog" }).task.status, "backlog");
  assert.equal(normalizeExternalTask({ name: "a" }).task.status, "pending");
});

test("handles the different shapes providers actually return", () => {
  // Asana-shaped
  const asana = normalizeExternalTask({
    gid: "1201", name: "Ship the thing", notes: "details", completed: false,
    due_on: "2026-08-20", assignee: { email: "dev@x.com" },
  });
  assert.equal(asana.externalId, "1201");
  assert.equal(asana.task.task, "Ship the thing");
  assert.equal(asana.task.description, "details");
  assert.equal(asana.task.due_date, "2026-08-20");

  // YouTrack-shaped (nested state object, epoch-millis date)
  const youtrack = normalizeExternalTask({
    idReadable: "PRJ-7", summary: "Fix crash", description: "stack trace",
    state: { name: "In Progress" }, priority: { name: "Critical" },
    dueDate: 1786000000000, type: { name: "Bug" },
  });
  assert.equal(youtrack.externalId, "PRJ-7");
  assert.equal(youtrack.task.status, "in-progress");
  assert.equal(youtrack.task.priority, "high");
  assert.equal(youtrack.task.task_type, "bug");
  assert.match(youtrack.task.due_date, /^\d{4}-\d{2}-\d{2}$/);

  // Jira-shaped (deeply nested under fields.*)
  const jira = normalizeExternalTask({
    key: "ENG-42",
    fields: { summary: "Refactor", status: { name: "Done" }, priority: { name: "Low" },
              issuetype: { name: "Story" }, duedate: "2026-09-01" },
  });
  assert.equal(jira.externalId, "ENG-42");
  assert.equal(jira.task.task, "Refactor");
  assert.equal(jira.task.status, "completed");
  assert.equal(jira.task.priority, "low");
  assert.equal(jira.task.task_type, "feature");
});

test("admin field and value mappings override the built-in guesses", () => {
  const result = normalizeExternalTask(
    { custom: { headline: "Mapped title", stage: "QA" } },
    {
      fieldMappings: { title: "custom.headline", status: "custom.stage" },
      valueMappings: { status: { QA: "in-progress" } },
    }
  );
  assert.equal(result.task.task, "Mapped title");
  assert.equal(result.task.status, "in-progress");
});

test("never emits values the tasks table would reject", () => {
  const result = normalizeExternalTask({
    name: "x".repeat(900),
    priority: "nonsense", type: "nonsense", status: "nonsense",
    due_date: "not-a-date", story_points: "abc", is_blocked: "yes",
  });
  assert.ok(result.task.task.length <= 500, "title must be truncated");
  assert.ok(["high", "medium", "low"].includes(result.task.priority));
  assert.ok(["task", "bug", "feature", "improvement", "chore"].includes(result.task.task_type));
  assert.ok(["pending", "in-progress", "completed", "backlog"].includes(result.task.status));
  assert.equal(result.task.due_date, null, "invalid dates must be null, never Invalid Date");
  assert.equal(result.task.story_points, null);
  assert.equal(result.task.is_blocked, true);
});

test("missing and malformed input degrades instead of throwing", () => {
  for (const input of [null, undefined, {}, { name: null }, []]) {
    const result = normalizeExternalTask(input);
    assert.equal(typeof result.task.task, "string");
    assert.ok(result.task.task.length > 0);
  }
  assert.equal(normalizeDate(null), null);
  assert.equal(normalizeDate("garbage"), null);
  assert.equal(getPath(null, "a.b"), undefined);
  assert.equal(getPath({ a: { b: 1 } }, "a.b"), 1);
  assert.equal(getPath({ a: [{ b: 2 }] }, "a.0.b"), 2);
});

test("assignee matching unifies the per-provider heuristics", () => {
  const users = [
    { id: "u1", email: "Dev@Example.com", username: "dev" },
    { id: "u2", email: "qa@example.com", username: "qaLead" },
  ];
  assert.equal(matchAssignee("dev@example.com", users), "u1", "email, case-insensitive");
  assert.equal(matchAssignee({ email: "DEV@EXAMPLE.COM" }, users), "u1", "object form");
  assert.equal(matchAssignee("qalead", users), "u2", "username, case-insensitive");
  assert.equal(matchAssignee("qa", users), "u2", "email local-part");
  assert.equal(matchAssignee("nobody@else.com", users), null);
  assert.equal(matchAssignee(null, users), null);
  assert.equal(matchAssignee("dev", []), null);
});

test("provider capability descriptors are complete and self-consistent", () => {
  const providers = listBuiltInProviders();
  assert.ok(providers.length >= 3);
  for (const provider of providers) {
    assert.ok(provider.key && provider.name, "must be identifiable");
    assert.ok(["oauth", "token", "none"].includes(provider.authType));
    assert.ok(["auto", "manual", "none"].includes(provider.webhookMode));
    // A token-auth provider the UI must render a form for needs field definitions.
    if (provider.authType === "token") {
      assert.ok(provider.authFields.length > 0, `${provider.key} needs authFields`);
    }
    // Anything claiming real-time must also be sweepable, or missed webhooks
    // would drift forever with nothing to correct them.
    if (provider.webhookMode !== "none") {
      assert.equal(provider.supportsReconciliation, true,
        `${provider.key} has webhooks so it must support reconciliation`);
    }
  }
});

test("custom provider keys can never collide with built-ins", () => {
  const key = customProviderKey("linear");
  assert.equal(key, "custom:linear");
  assert.equal(isCustomProvider(key), true);
  assert.equal(customProviderSlug(key), "linear");
  // A built-in name stays distinct even if someone names their custom one "asana".
  assert.notEqual(customProviderKey("asana"), "asana");
  assert.equal(isCustomProvider("asana"), false);
  assert.equal(customProviderSlug("asana"), null);

  const described = describeCustomProvider({
    provider_key: "linear", name: "Linear", auth_type: "bearer", status: "active",
    endpoints: { projects: { path: "/teams" }, tasks: { path: "/issues" } },
  });
  assert.equal(described.key, "custom:linear");
  assert.equal(described.builtIn, false);
  assert.equal(described.supportsProjects, true);
  assert.equal(described.supportsReconciliation, true);
  // No tasks endpoint means nothing to sweep.
  assert.equal(
    describeCustomProvider({ provider_key: "x", name: "X", auth_type: "none", endpoints: {} })
      .supportsReconciliation,
    false
  );
});
