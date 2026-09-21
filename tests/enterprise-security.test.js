import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { parseEqualityFilter, userInput } from "../routes/scim.routes.js";
import {
  hasWorkspacePermission,
  requiredWorkspacePermission,
  validatePermissions,
} from "../services/workspaceSecurity.service.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("custom roles are least-privilege and existing unassigned roles remain unaffected", () => {
  assert.equal(requiredWorkspacePermission({ method: "GET", baseUrl: "/tasks" }), "read:tasks");
  assert.equal(requiredWorkspacePermission({ method: "POST", baseUrl: "/users" }), "manage:users");
  assert.equal(hasWorkspacePermission(["write:tasks"], "read:tasks"), true);
  assert.equal(hasWorkspacePermission(["read:tasks"], "write:tasks"), false);
  assert.equal(hasWorkspacePermission([], null), true);
  assert.throws(() => validatePermissions(["become:superadmin"]), /Unsupported permission/);
});

test("SCIM accepts bounded equality filters and normalizes user identities", () => {
  assert.deepEqual(parseEqualityFilter('userName eq "Person@Example.com"', ["username"]), {
    attribute: "username", value: "Person@Example.com",
  });
  assert.throws(() => parseEqualityFilter('userName co "example"', ["username"]));
  assert.deepEqual(userInput({ userName: " Person@Example.com ", displayName: " Person ", active: true }), {
    email: "person@example.com", displayName: "Person", externalId: null, active: true,
  });
});

test("enterprise migrations are additive and all new tenant tables enable RLS", () => {
  const migration = read("migrations/20260921_enterprise_completion.sql");
  for (const table of [
    "workspace_security_policies", "workspace_domains", "enterprise_roles",
    "scim_tokens", "scim_external_identities", "scim_groups", "scim_group_members",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN/i);
});

test("SCIM deprovisioning revokes sessions instead of deleting business history", () => {
  const source = read("routes/scim.routes.js");
  assert.match(source, /SET disabled_at = now\(\)/);
  assert.match(source, /DELETE FROM user_sessions/);
  assert.doesNotMatch(source, /DELETE FROM users/);
});
