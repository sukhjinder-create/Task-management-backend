import test from "node:test";
import assert from "node:assert/strict";
import {
  isProjectInScope,
  SYNC_MODES,
  MIN_RECONCILE_MINUTES,
  MAX_RECONCILE_MINUTES,
} from "../integrations/sync/integration.syncConfig.repository.js";

test("an empty scope means every project, preserving pre-scoping behaviour", () => {
  // Critical: existing integrations backfilled with '[]' must keep syncing
  // everything, not silently stop syncing.
  assert.equal(isProjectInScope({ scoped_project_ids: [] }, "123"), true);
  assert.equal(isProjectInScope({ scoped_project_ids: null }, "123"), true);
  assert.equal(isProjectInScope({}, "123"), true);
  assert.equal(isProjectInScope(null, "123"), true);
});

test("a non-empty scope admits only the listed projects", () => {
  const config = { scoped_project_ids: ["111", "222"] };
  assert.equal(isProjectInScope(config, "111"), true);
  assert.equal(isProjectInScope(config, "222"), true);
  assert.equal(isProjectInScope(config, "999"), false);
  // Ids arrive as numbers from some providers and strings from others.
  assert.equal(isProjectInScope(config, 111), true);
  assert.equal(isProjectInScope({ scoped_project_ids: [111] }, "111"), true);
});

test("reconcile bounds prevent recreating the old hammer-the-API behaviour", () => {
  // The floor is what stops an admin setting a 10-second sweep and reproducing
  // the continuous polling this work removed.
  assert.ok(MIN_RECONCILE_MINUTES >= 5, "floor must keep sweeps infrequent");
  assert.ok(MAX_RECONCILE_MINUTES <= 43200, "ceiling must keep drift bounded");
  assert.ok(MIN_RECONCILE_MINUTES < MAX_RECONCILE_MINUTES);
});

test("sync modes cover real-time, fallback polling, manual and off", () => {
  assert.deepEqual(SYNC_MODES, ["webhook", "poll", "manual", "disabled"]);
  // 'poll' must exist: a provider with no webhook support cannot be real-time,
  // and pretending otherwise would mean it silently never updated.
  assert.ok(SYNC_MODES.includes("poll"));
  // 'disabled' must exist so an admin can stop all outbound traffic entirely.
  assert.ok(SYNC_MODES.includes("disabled"));
});

test("provider sync accepts a project scope without breaking its old signature", async () => {
  // Guards the compatibility contract: providers must still work when called
  // with no scope (every existing caller), and must accept one when given.
  const { default: AsanaProvider } = await import("../integrations/providers/asana.provider.js");
  const { default: YouTrackProvider } = await import("../integrations/providers/youtrack.provider.js");

  for (const [name, Provider] of [["asana", AsanaProvider], ["youtrack", YouTrackProvider]]) {
    const instance = typeof Provider === "function" ? new Provider() : Provider;
    assert.equal(typeof instance.sync, "function", `${name} must expose sync()`);
    // Reading the source is the only way to assert the destructured parameter
    // exists without making live API calls.
    assert.match(
      instance.sync.toString(),
      /scopedProjectIds/,
      `${name}.sync must accept scopedProjectIds`
    );
  }
});
