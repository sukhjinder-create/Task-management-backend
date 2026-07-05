// tests/ai-platform-studio.test.js
//
// Epic C self-test: the AI Studio control-plane backbone — governance permission
// matrix, lock/inheritance model, secret-redacting read-models, and the service
// layer. Hermetic (pure logic; no DB, no network).

import { test } from "node:test";
import assert from "node:assert/strict";

import { can, permittedVerbs, ROLES, VERBS } from "../ai-platform/governance/permissions.js";
import { resolveLockedValue, workspaceCanOverride, describeLock, LOCK_LEVELS } from "../ai-platform/governance/locks.js";
import { providerViewModel, listCapabilityViewModels, findLeakedSecret } from "../ai-platform/studio/readModels.js";
import { getOverview, computeEffectiveConfig, getWorkspaceControls } from "../ai-platform/studio/aiStudioService.js";

// ── Governance permission matrix (Contract §9) ────────────────────────────────
test("permission matrix: superadmin all; workspace roles gated by scope + lock + SoD", () => {
  // Superadmin can do everything.
  for (const verb of VERBS) assert.equal(can({ role: "superadmin", verb, scope: "PLATFORM" }).allowed, true);

  // Workspace admin may override only when customizable.
  assert.equal(can({ role: "workspace_admin", verb: "override", scope: { workspaceId: "w" }, lockLevel: "workspace_customizable" }).allowed, true);
  assert.equal(can({ role: "workspace_admin", verb: "override", scope: { workspaceId: "w" }, lockLevel: "global_locked" }).allowed, false);
  assert.equal(can({ role: "workspace_admin", verb: "override", scope: { workspaceId: "w" }, lockLevel: "workspace_locked" }).allowed, false);

  // Workspace roles cannot act at PLATFORM scope.
  assert.equal(can({ role: "workspace_admin", verb: "view", scope: "PLATFORM" }).allowed, false);

  // Viewer can only view.
  assert.equal(can({ role: "workspace_viewer", verb: "view", scope: { workspaceId: "w" } }).allowed, true);
  assert.equal(can({ role: "workspace_viewer", verb: "override", scope: { workspaceId: "w" } }).allowed, false);

  // Separation of duties: an author cannot approve their own change.
  assert.equal(can({ role: "platform_operator", verb: "approve", isAuthor: true }).allowed, false);
  assert.equal(can({ role: "platform_operator", verb: "approve", isAuthor: false }).allowed, true);

  // permittedVerbs is a subset for a viewer.
  const pv = permittedVerbs({ role: "workspace_viewer", scope: { workspaceId: "w" } });
  assert.deepEqual(pv, ["view"]);
  assert.ok(ROLES.includes("workspace_admin"));
});

// ── Lock / inheritance model (Contract §9/§12) ────────────────────────────────
test("lock resolution matches the runtime resolver semantics", () => {
  // global_locked → platform wins, workspace ignored.
  assert.equal(resolveLockedValue("global_locked", "P", "W"), "P");
  // customizable → workspace wins if present.
  assert.equal(resolveLockedValue("workspace_customizable", "P", "W"), "W");
  assert.equal(resolveLockedValue("workspace_customizable", "P", null), "P");
  // workspace_locked → pinned value (workspace value) wins.
  assert.equal(resolveLockedValue("workspace_locked", "P", "W"), "W");

  assert.equal(workspaceCanOverride("workspace_customizable"), true);
  assert.equal(workspaceCanOverride("global_locked"), false);
  assert.equal(describeLock("global_locked").editable, false);
  assert.equal(describeLock("workspace_customizable").editable, true);
  assert.equal(LOCK_LEVELS.length, 3);
});

// ── Read-model secret redaction (SECURITY) ────────────────────────────────────
test("provider view-model never leaks a secret value; shows reference + configured", () => {
  process.env.GROQ_API_KEY = "sk-LEAK-CANARY-123";
  try {
    const vm = providerViewModel("groq");
    assert.equal(vm.keyOwnership.configured, true, "shows configured=true (presence only)");
    assert.deepEqual(vm.keyOwnership.keyRef, { manager: "env", ref: "GROQ_API_KEY" }, "reference name only");
    assert.equal(findLeakedSecret(vm, ["sk-LEAK-CANARY-123"]), null, "no secret value in the view-model");
  } finally {
    delete process.env.GROQ_API_KEY;
  }
});

// ── Service layer ─────────────────────────────────────────────────────────────
test("overview counts + effective config honor lock precedence", () => {
  const o = getOverview();
  assert.equal(o.platform.contractVersion, "2.0");
  assert.ok(o.counts.providers >= 10 && o.counts.capabilities >= 15);

  const eff = computeEffectiveConfig({
    capabilityKey: "workspace_assistant",
    workspaceOverride: { provider: "anthropic" },
    lockLevel: "workspace_customizable",
  });
  assert.equal(eff.effective.provider, "anthropic"); // customizable → override wins

  const locked = computeEffectiveConfig({
    capabilityKey: "workspace_assistant",
    workspaceOverride: { provider: "anthropic" },
    lockLevel: "global_locked",
  });
  assert.equal(locked.effective.provider, locked.platform.provider); // global_locked → override ignored
});

test("workspace controls expose editability per lock + role", () => {
  const open = getWorkspaceControls({ role: "workspace_admin", capabilityKey: "ai_features", lockLevel: "workspace_customizable" });
  assert.equal(open.controls.provider.editable, true);
  assert.ok(open.permittedVerbs.includes("override"));

  const locked = getWorkspaceControls({ role: "workspace_admin", capabilityKey: "ai_features", lockLevel: "global_locked" });
  assert.equal(locked.controls.provider.editable, false);
  assert.equal(locked.controls.provider.badge, "Locked by platform");

  const viewer = getWorkspaceControls({ role: "workspace_viewer", capabilityKey: "ai_features", lockLevel: "workspace_customizable" });
  assert.equal(viewer.controls.provider.editable, false); // viewer cannot override

  assert.ok(listCapabilityViewModels().length >= 15);
});
