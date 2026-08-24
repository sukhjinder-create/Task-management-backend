import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import db from "../db.js";
import { createEmailVerificationSecret } from "../services/emailVerification.service.js";
import { generateToken } from "../services/auth.service.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

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

test("requiring email verification blocks new and already-issued access tokens", async () => {
  const user = {
    id: "10000000-0000-4000-8000-000000000001",
    username: "Security Test",
    email: "security@example.com",
    role: "admin",
    workspaceId: "20000000-0000-4000-8000-000000000002",
    email_verified_at: new Date(),
  };
  const token = generateToken(user);

  assert.throws(
    () => generateToken({ ...user, email_verified_at: null }),
    (error) => error.code === "EMAIL_VERIFICATION_REQUIRED"
  );

  const originalQuery = db.query;
  db.query = async () => ({ rows: [{ ...user, email_verified_at: null }] });
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };

  try {
    await authMiddleware(
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
      response,
      () => { nextCalled = true; }
    );
  } finally {
    db.query = originalQuery;
  }

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.equal(body.code, "EMAIL_VERIFICATION_REQUIRED");
});
