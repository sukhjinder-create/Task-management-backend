import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import jwt from "jsonwebtoken";
import {
  classifyTrafficSource,
  deterministicGrowthEventId,
  detectBrowser,
  detectDevice,
  normalizeGrowthEvent,
} from "../growth/growthEvent.js";
import { matchProductGrowthEvent } from "../growth/growthProductTelemetry.middleware.js";
import { parseGrowthRange } from "../growth/growthDashboard.service.js";
import {
  getSuperadminJwtSecret,
  validateSuperadminPassword,
  verifySuperadminAccessToken,
} from "../services/superadmin.service.js";

test("public telemetry accepts website events and strips unsafe content", () => {
  const event = normalizeGrowthEvent({
    eventName: "website.page_view",
    anonymousId: "anon-1",
    sessionId: "session-1",
    pagePath: "/pricing?secret=value#section",
    properties: {
      viewport_width: 1280,
      password: "must-not-survive",
      message: "private text",
    },
  }, { publicEvent: true });
  assert.equal(event.pagePath, "/pricing");
  assert.deepEqual(event.properties, { viewport_width: 1280 });
  assert.equal(event.category, "website");
});

test("public clients cannot forge product lifecycle events", () => {
  assert.throws(
    () => normalizeGrowthEvent({ eventName: "product.workspace_created" }, { publicEvent: true }),
    /not accepted/
  );
});

test("semantic milestone ids are stable for idempotent retries", () => {
  const first = deterministicGrowthEventId("product.workspace_created:workspace-1");
  const second = deterministicGrowthEventId("product.workspace_created:workspace-1");
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
});

test("device, browser, and acquisition classification are deterministic", () => {
  const iphoneChrome = "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/126.0 Mobile";
  assert.equal(detectDevice(iphoneChrome), "mobile");
  assert.equal(detectBrowser(iphoneChrome), "Chrome");
  assert.equal(classifyTrafficSource({ referrerHost: "www.google.com" }), "organic_search");
  assert.equal(classifyTrafficSource({ utmSource: "partner-campaign" }), "partner-campaign");
});

test("product middleware records only successful allowlisted actions", () => {
  assert.equal(matchProductGrowthEvent("POST", "/projects", 201)?.eventName, "product.project_created");
  assert.equal(matchProductGrowthEvent("POST", "/tasks/nl/create", 201), null);
  assert.equal(matchProductGrowthEvent("POST", "/projects", 403), null);
  assert.equal(matchProductGrowthEvent("GET", "/projects", 200), null);
});

test("dashboard date ranges are bounded", () => {
  const range = parseGrowthRange({ from: "2026-06-01", to: "2026-06-29" });
  assert.equal(range.days, 29);
  assert.throws(() => parseGrowthRange({ from: "2024-01-01", to: "2026-01-01" }), /366 days/);
});

test("Super Admin verifier rejects ordinary user tokens", () => {
  const secret = getSuperadminJwtSecret();
  const valid = jwt.sign(
    { sub: "11111111-1111-4111-8111-111111111111", sid: "22222222-2222-4222-8222-222222222222", role: "superadmin", type: "superadmin" },
    secret,
    { issuer: "asystence-superadmin", audience: "asystence-platform-console", expiresIn: "1m" }
  );
  assert.equal(verifySuperadminAccessToken(valid).role, "superadmin");
  const ordinary = jwt.sign({ id: "user-1", role: "admin" }, secret, { expiresIn: "1m" });
  assert.throws(() => verifySuperadminAccessToken(ordinary));
});

test("Super Admin recovery enforces the dedicated strong-password policy", () => {
  assert.equal(validateSuperadminPassword("Strong-Admin-Password-42!"), "Strong-Admin-Password-42!");
  assert.throws(() => validateSuperadminPassword("short"), /at least 12/);
  assert.throws(() => validateSuperadminPassword("alllowercasepassword"), /upper, lower, number, and symbol/);
  assert.throws(() => validateSuperadminPassword("NoSymbolPassword42"), /upper, lower, number, and symbol/);
});

test("migration has dedicated sessions, event idempotency, and query indexes", () => {
  const sql = fs.readFileSync(new URL("../migrations/20260629_superadmin_growth_intelligence.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS superadmin_sessions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS growth_events/);
  assert.match(sql, /refresh_token_hash\s+TEXT NOT NULL UNIQUE/);
  assert.match(sql, /idx_growth_events_name_time/);
});

test("password recovery migration stores only hashed, expiring, single-use tokens", () => {
  const sql = fs.readFileSync(new URL("../migrations/20260629_superadmin_password_recovery.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS superadmin_password_reset_tokens/);
  assert.match(sql, /token_hash\s+TEXT NOT NULL UNIQUE/);
  assert.match(sql, /expires_at\s+TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /used_at\s+TIMESTAMPTZ/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
});
