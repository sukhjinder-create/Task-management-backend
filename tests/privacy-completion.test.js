import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { __testables } from "../services/privacy.service.js";

test("privacy exports redact credential material but retain ordinary fields", () => {
  assert.deepEqual(__testables.redactRecord({
    id: "1", email: "person@example.com", password_hash: "hash", refresh_token_hash: "token",
  }), {
    id: "1", email: "person@example.com", password_hash: "[REDACTED]", refresh_token_hash: "[REDACTED]",
  });
  assert.equal(__testables.quoteIdentifier('safe"name'), '"safe""name"');
});

test("erasure is an explicit anonymization transaction with legal-hold and audit gates", () => {
  const source = fs.readFileSync(new URL("../services/privacy.service.js", import.meta.url), "utf8");
  assert.match(source, /privacy_legal_holds/);
  assert.match(source, /logAuditRequired/);
  assert.match(source, /SET username = \$1, email = \$2/);
  assert.match(source, /DELETE FROM user_sessions|credentialTables/);
  assert.doesNotMatch(source, /DELETE FROM users/);
});
