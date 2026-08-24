import test from "node:test";
import assert from "node:assert/strict";
import { verifyTurnstile } from "../services/turnstile.service.js";

test("Turnstile failures remain closed and expose a retryable error code", async () => {
  const originalFetch = global.fetch;
  const originalSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalWarn = console.warn;
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  console.warn = () => {};
  global.fetch = async () => new Response(JSON.stringify({
    success: false,
    "error-codes": ["timeout-or-duplicate"],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    await assert.rejects(
      () => verifyTurnstile("spent-token", "203.0.113.10", "signup"),
      (error) => error.code === "TURNSTILE_FAILED" && error.statusCode === 400 && /expired/i.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
  }
});
