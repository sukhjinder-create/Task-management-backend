import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import db from "../db.js";
import { createEmailVerificationSecret } from "../services/emailVerification.service.js";

after(async () => db.end());

test("email verification credentials are random, hashed, and short-lived", () => {
  const now = Date.parse("2026-08-24T10:00:00.000Z");
  const first = createEmailVerificationSecret(now);
  const second = createEmailVerificationSecret(now);

  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(
    first.tokenHash,
    crypto.createHash("sha256").update(first.token).digest("hex")
  );
  assert.equal(first.expiresAt.toISOString(), "2026-08-24T10:30:00.000Z");
  assert.equal(first.tokenHash.includes(first.token), false);
});
