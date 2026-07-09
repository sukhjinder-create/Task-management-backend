// tests/startup-validation.test.js
//
// Production-readiness startup validation — hermetic + deterministic. Verifies config /
// flag-safety checks and that NO secret values ever appear in the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStartup, validateFlagSafety, EXPECTED_MIGRATIONS, truthy } from "../ops/startupValidation.js";

test("safe defaults: no platform flags on → ready, no errors", () => {
  const r = validateStartup({ env: { JWT_SECRET: "x", DATABASE_URL: "postgres://h/db" }, migrationFiles: EXPECTED_MIGRATIONS, isProduction: true });
  assert.equal(r.ok, true);
  assert.equal(r.checks.safeDefaults, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.checks.migrationsPresent, EXPECTED_MIGRATIONS.length);
});

test("production requires DB + JWT; missing → errors", () => {
  const r = validateStartup({ env: {}, migrationFiles: [], isProduction: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /database/i.test(e)));
  assert.ok(r.errors.some((e) => /JWT_SECRET/.test(e)));
});

test("weak secret is warned but never printed", () => {
  const r = validateStartup({ env: { JWT_SECRET: "task_management_secret", DATABASE_URL: "x", AI_SERVICE_SECRET: "super-secret-token" }, migrationFiles: EXPECTED_MIGRATIONS, isProduction: true });
  assert.ok(r.warnings.some((w) => /JWT_SECRET is a known weak/.test(w)));
  assert.ok(r.warnings.some((w) => /AI_SERVICE_SECRET is a known weak/.test(w)));
  // The secret VALUE must not leak into any field.
  const blob = JSON.stringify(r);
  assert.equal(blob.includes("task_management_secret"), false);
  assert.equal(blob.includes("super-secret-token"), false);
});

test("flag-safety: side-effects without master flag warns", () => {
  const { warnings } = validateFlagSafety({ EXEC_SIDE_EFFECTS_ENABLED: "true", EXEC_ENABLED: "false" }, false);
  assert.ok(warnings.some((w) => /EXEC_SIDE_EFFECTS_ENABLED/.test(w)));
});

test("flag-safety: platform flags on in production is warned, not fatal", () => {
  const r = validateStartup({ env: { JWT_SECRET: "x", DATABASE_URL: "x", EXEC_ENABLED: "true", EI_STUDIO_ENABLED: "true" }, migrationFiles: EXPECTED_MIGRATIONS, isProduction: true });
  assert.equal(r.ok, true); // warning, not error
  assert.equal(r.checks.safeDefaults, false);
  assert.deepEqual(r.checks.platformFlagsEnabled.sort(), ["EI_STUDIO_ENABLED", "EXEC_ENABLED"]);
});

test("missing migrations are warned", () => {
  const r = validateStartup({ env: { JWT_SECRET: "x", DATABASE_URL: "x" }, migrationFiles: [], isProduction: false });
  assert.ok(r.warnings.some((w) => /migration files not present/i.test(w)));
  assert.equal(truthy("YES"), true);
  assert.equal(truthy("0"), false);
});
