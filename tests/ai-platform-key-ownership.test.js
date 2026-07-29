// tests/ai-platform-key-ownership.test.js
//
// P8 self-test: KeyRef resolution + key ownership model + backward-compatible
// adapter key resolution. Hermetic — process.env only, no network/DB. Secrets are
// never returned in errors.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveKeyRef, SECRET_MANAGERS, isSecretManager } from "../ai-platform/keys/keyRef.js";
import { resolveKeyOwnership } from "../ai-platform/keys/keyOwnership.js";
import { resolveApiKey } from "../ai-platform/providers/base.adapter.js";

test("KeyRef resolves env-backed secrets and fails loudly for unwired managers", () => {
  process.env.__AITEST_KEY = "secret-value";
  try {
    assert.equal(resolveKeyRef({ manager: "env", ref: "__AITEST_KEY" }), "secret-value");
    assert.equal(resolveKeyRef({ manager: "env", ref: "__MISSING__" }), "");
    assert.equal(resolveKeyRef(null), "");

    // External managers are scaffolded → throw, and the error must NOT leak the ref.
    let threw = null;
    try { resolveKeyRef({ manager: "vault", ref: "super/secret/path" }); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === "SECRET_MANAGER_NOT_IMPLEMENTED");
    assert.ok(!threw.message.includes("super/secret/path"), "error must not leak the ref");
    assert.ok(isSecretManager("kms") && SECRET_MANAGERS.includes("env"));
  } finally {
    delete process.env.__AITEST_KEY;
  }
});

test("key ownership default is platform-managed and maps to the existing env var", () => {
  const own = resolveKeyOwnership({ providerKey: "groq", workspaceId: "ws-9" });
  assert.equal(own.mode, "platform_managed");
  assert.equal(own.billingOwner, "platform");
  assert.deepEqual(own.keyRef, { manager: "env", ref: "GROQ_API_KEY" });
  assert.deepEqual(own.costOwner, { workspaceId: "ws-9" });
});

test("adapter key resolution prefers KeyRef, else falls back to env (backward compatible)", () => {
  process.env.__AITEST_PROVIDER_KEY = "env-key";
  process.env.__AITEST_REF_KEY = "ref-key";
  try {
    // Legacy path: no keyRef → env-name lookup unchanged.
    assert.equal(resolveApiKey({ apiKeyEnv: "__AITEST_PROVIDER_KEY" }), "env-key");
    // P8 path: a KeyRef wins.
    assert.equal(
      resolveApiKey({ apiKeyEnv: "__AITEST_PROVIDER_KEY", keyRef: { manager: "env", ref: "__AITEST_REF_KEY" } }),
      "ref-key"
    );
    // Misconfigured KeyRef → graceful fallback to env (never breaks).
    assert.equal(
      resolveApiKey({ apiKeyEnv: "__AITEST_PROVIDER_KEY", keyRef: { manager: "vault", ref: "x" } }),
      "env-key"
    );
  } finally {
    delete process.env.__AITEST_PROVIDER_KEY;
    delete process.env.__AITEST_REF_KEY;
  }
});
