import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  accessTokenFromCookie,
  browserSafeAuthPayload,
  refreshTokenFromCookie,
} from "../services/browserSession.service.js";

test("browser auth credentials move to HttpOnly cookies and stay out of JSON", () => {
  const cookies = [];
  const cleared = [];
  const req = {
    headers: {
      origin: "http://localhost:5173",
      "x-auth-mode": "cookie",
    },
  };
  const res = {
    cookie: (name, value, options) => cookies.push({ name, value, options }),
    clearCookie: (name, options) => cleared.push({ name, options }),
  };

  const payload = browserSafeAuthPayload(req, res, {
    user: { id: "user-1" },
    token: "access-secret",
    refreshToken: "refresh-secret",
  });

  assert.deepEqual(payload, { user: { id: "user-1" } });
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every(({ options }) => options.httpOnly && options.sameSite === "strict"));
  assert.equal(cleared[0].name, "asystence_mfa");

  const cookieHeader = cookies.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
  assert.equal(accessTokenFromCookie({ headers: { cookie: cookieHeader } }), "access-secret");
  assert.equal(refreshTokenFromCookie({ headers: { cookie: cookieHeader } }), "refresh-secret");
});

test("human intelligence and member rosters exclude system identities", async () => {
  const [intelligence, members, aiFeatures] = await Promise.all([
    readFile(new URL("../intelligence/enterpriseIntelligence.service.js", import.meta.url), "utf8"),
    readFile(new URL("../routes/workspace.routes.js", import.meta.url), "utf8"),
    readFile(new URL("../services/aiFeatures.service.js", import.meta.url), "utf8"),
  ]);

  assert.equal((intelligence.match(/COALESCE\(u\.is_system, false\) = false/g) || []).length, 3);
  assert.match(members, /COALESCE\(u\.is_system, false\) = false/);
  assert.match(aiFeatures, /COALESCE\(u\.is_system, false\) = false/);
});

test("Asana browser OAuth uses authenticated session and signed expiring state", async () => {
  const source = await readFile(
    new URL("../integrations/asana/asana.oauth.routes.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /authMiddleware\(req, res, next\)/);
  assert.match(source, /audience: "asana-oauth"/);
  assert.match(source, /expiresIn: "10m"/);
  assert.match(source, /jwt\.verify\(state/);
});
