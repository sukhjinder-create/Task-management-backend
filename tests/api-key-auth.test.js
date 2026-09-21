import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import {
  apiKeyHasScope,
  authenticateApiKey,
  requiredScopeForRequest,
  validateApiKeyScopes,
} from "../services/apiKey.service.js";

test("API key scopes are resource-specific and writes imply reads", () => {
  assert.equal(apiKeyHasScope(["read:tasks"], "read:tasks"), true);
  assert.equal(apiKeyHasScope(["read:tasks"], "write:tasks"), false);
  assert.equal(apiKeyHasScope(["write:tasks"], "read:tasks"), true);
  assert.equal(apiKeyHasScope(["read:*"], "read:projects"), true);
  assert.equal(apiKeyHasScope(["read:tasks"], "read:users"), false);
  assert.equal(requiredScopeForRequest({ method: "POST", baseUrl: "/subtasks" }), "write:tasks");
});

test("API key scope input rejects privilege strings the platform does not expose", () => {
  assert.deepEqual(validateApiKeyScopes(["read:tasks", "read:tasks"]), ["read:tasks"]);
  assert.throws(() => validateApiKeyScopes(["admin"]), /Unsupported/);
  assert.throws(() => validateApiKeyScopes([]), /At least one/);
});

test("API keys are verified, expiry-filtered by SQL, and usage is recorded", async () => {
  const raw = `asy_${"a".repeat(64)}`;
  const keyHash = await bcrypt.hash(raw, 4);
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SELECT ak.id")) return { rows: [{
        id: "key-1", workspace_id: "workspace-1", user_id: "user-1",
        key_hash: keyHash, scopes: ["read:tasks"], username: "service",
        email: "service@example.com", role: "user", email_verified_at: new Date(),
      }] };
      return { rowCount: 1, rows: [] };
    },
  };

  const authenticated = await authenticateApiKey(raw, database);
  assert.equal(authenticated.id, "key-1");
  assert.equal(authenticated.user.workspaceId, "workspace-1");
  assert.match(calls[0].sql, /expires_at IS NULL OR ak\.expires_at > now\(\)/);
  assert.match(calls[1].sql, /last_used_at = now\(\)/);
  assert.equal(await authenticateApiKey("asy_not-a-key", database), null);
});
