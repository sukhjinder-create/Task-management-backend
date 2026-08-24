import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "node:crypto";

process.env.JWT_SECRET ||= "rate-limit-test-secret-not-used-in-production";
process.env.RATE_LIMIT_ENABLED = "true";

const {
  generalLimiter,
  authLimiter,
  signupLimiter,
  emailVerificationLimiter,
} = await import("../middleware/rateLimit.middleware.js");

function b64url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signToken(userId) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    id: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
  }));
  const signature = crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(signature)}`;
}

function startTestServer() {
  const app = express();
  app.set("trust proxy", true);
  app.use(generalLimiter);
  app.get("/livez", (_req, res) => res.json({ ok: true }));
  app.get("/api/thing", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authLimiter, (_req, res) => res.status(401).json({ error: "bad creds" }));
  app.get("/signup", signupLimiter, (_req, res) => res.status(202).json({ ok: true }));
  app.get("/verify-email", emailVerificationLimiter, (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function request(base, path, { user, ip = "203.0.113.9" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (user) headers.Authorization = `Bearer ${signToken(user)}`;
  const res = await fetch(base + path, { headers });
  return res.status;
}

test("rate limiting protects the API without disrupting real usage", async (t) => {
  const { server, base } = startTestServer();
  t.after(() => server.close());

  await t.test("ordinary interactive traffic is never throttled", async () => {
    const codes = [];
    for (let i = 0; i < 50; i++) codes.push(await request(base, "/api/thing", { user: "alice" }));
    assert.ok(codes.every((c) => c === 200), `expected all 200, saw ${[...new Set(codes)]}`);
  });

  await t.test("health probes are exempt so monitoring can poll freely", async () => {
    const codes = [];
    for (let i = 0; i < 700; i++) codes.push(await request(base, "/livez"));
    assert.ok(codes.every((c) => c === 200), `expected all 200, saw ${[...new Set(codes)]}`);
  });

  await t.test("a runaway client is eventually limited", async () => {
    const codes = [];
    for (let i = 0; i < 620; i++) codes.push(await request(base, "/api/thing", { user: "bob" }));
    assert.ok(codes.includes(429), "expected the limiter to engage for a runaway client");
  });

  // Regression guard for the office-NAT case: colleagues share one public IP,
  // so limiting purely by IP would let one busy user lock out their whole team.
  await t.test("a different user behind the same IP keeps working", async () => {
    const status = await request(base, "/api/thing", { user: "carol", ip: "203.0.113.9" });
    assert.equal(status, 200, "a second user on a shared office IP must not inherit another user's limit");
  });

  await t.test("auth limiter tolerates a whole office signing in", async () => {
    const codes = [];
    for (let i = 0; i < 60; i++) codes.push(await request(base, "/auth/login", { ip: "198.51.100.7" }));
    assert.ok(codes.every((c) => c === 401), `expected all 401 (limiter not engaged), saw ${[...new Set(codes)]}`);
  });

  await t.test("successful workspace signup abuse is limited", async () => {
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push(await request(base, "/signup", { ip: "198.51.100.8" }));
    assert.equal(codes.at(-1), 429);
  });

  await t.test("verification email flooding is limited", async () => {
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push(await request(base, "/verify-email", { ip: "198.51.100.9" }));
    assert.equal(codes.at(-1), 429);
  });
});
