// tests/ai-platform-studio-apis.test.js
//
// Epic C API-layer self-test: the verifiable (pure / DI) logic behind the Studio
// write APIs — prompt version state machine, audit record building, capability-
// config validation (pre-DB), lock validation, and the playground via DI.
// DB persistence itself is UNVERIFIED AT RUNTIME (needs a migrated database).

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import { canTransition, planTransition, nextVersionNumber, publishedVersion, PROMPT_STATUSES } from "../ai-platform/studio/promptVersions.js";
import { buildAuditRecord } from "../ai-platform/studio/audit.service.js";
import { upsertCapabilityConfig, setLock } from "../ai-platform/studio/configStore.service.js";
import { runPlayground } from "../ai-platform/studio/playground.service.js";
import { MockAdapter } from "../ai-platform/testing/index.js";

test("prompt version state machine: transitions, publish archives prior, approval gate", () => {
  assert.equal(PROMPT_STATUSES.length, 4);
  assert.equal(canTransition("draft", "published"), true);
  assert.equal(canTransition("published", "draft"), false);
  assert.equal(canTransition("archived", "published"), true); // rollback

  // Publishing v2 archives the currently-published v1.
  const plan = planTransition({ versions: [{ version: 1, status: "published" }, { version: 2, status: "testing" }], version: 2, to: "published" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.mutations.sort((a, b) => a.version - b.version), [
    { version: 1, status: "archived" },
    { version: 2, status: "published" },
  ]);

  // Illegal transition rejected.
  assert.equal(planTransition({ versions: [{ version: 1, status: "published" }], version: 1, to: "draft" }).ok, false);
  // Approval required.
  assert.equal(planTransition({ versions: [{ version: 1, status: "draft" }], version: 1, to: "published", requireApproval: true, approved: false }).ok, false);
  assert.equal(planTransition({ versions: [{ version: 1, status: "draft" }], version: 1, to: "published", requireApproval: true, approved: true }).ok, true);

  assert.equal(nextVersionNumber([{ version: 1 }, { version: 3 }]), 4);
  assert.equal(publishedVersion([{ version: 1, status: "archived" }, { version: 2, status: "published" }]).version, 2);
});

test("audit record builder produces a complete, typed record", () => {
  const r = buildAuditRecord({ actorType: "superadmin", actorId: "sa1", action: "publish", objectType: "prompt_version", objectKey: "p#2", after: { to: "published" } });
  assert.equal(r.action, "publish");
  assert.equal(r.objectKey, "p#2");
  assert.deepEqual(r.after, { to: "published" });
  assert.ok(r.ts);
});

test("capability-config validation rejects incompatible provider / unknown capability (pre-DB)", async () => {
  // meeting_intelligence needs 32k context → ollama (8k) is incompatible.
  const bad = await upsertCapabilityConfig({ capabilityKey: "meeting_intelligence", provider: "ollama" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "incompatible_provider");

  const unknown = await upsertCapabilityConfig({ capabilityKey: "nope", provider: "groq" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown_capability");

  // Invalid lock level rejected before any DB write.
  const lock = await setLock({ capabilityKey: "ai_features", lockLevel: "not_a_level" });
  assert.equal(lock.ok, false);
  assert.equal(lock.reason, "invalid_lock_level");
});

test("playground runs a capability through the gateway and returns the full response (DI)", async () => {
  const deps = {
    resolve: async ({ capabilityKey }) => ({
      capabilityKey, providerKey: "groq", adapterType: "mock",
      providerConfig: { key: "groq", defaultModel: "llama-3.3-70b-versatile" }, model: "llama-3.3-70b-versatile",
      profileKey: "balanced", profileParams: null, promptKey: null, requires: null,
    }),
    getAdapterFor: () => new MockAdapter({ fixedText: "playground reply" }),
    checkPolicies: async () => ({ allowed: true }),
    resolvePromptTemplate: async () => null,
    logAiRequest: async () => {},
  };
  const out = await runPlayground({ capability: "workspace_assistant", prompt: "hello studio" }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.text, "playground reply");
  assert.equal(out.response.status, "succeeded");
  assert.equal(out.response.resolution.provider, "groq");
  assert.equal(out.response.cost.currency, "USD");
  assert.ok(out.response.safety);
});
