// tests/public-workspace-slug.test.js
//
// Hermetic self-test for the slug-resolution endpoint the edge subdomain router
// depends on. Tests the pure projection layer only — no DB, no network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  isRoutableSlugShape,
  workspaceRoutingDecision,
} from "../routes/publicWorkspace.routes.js";

test("slug shape check accepts real workspace labels", () => {
  for (const slug of ["acme", "acme-corp", "a", "a1", "x".repeat(63)]) {
    assert.equal(isRoutableSlugShape(slug), true, slug);
  }
});

test("slug shape check rejects everything that cannot be a DNS label", () => {
  // Each of these previously reached the app and cost ~13 billed requests.
  const rejected = [
    "",
    "a.b",
    "under_score",
    "-leading",
    "trailing-",
    "UPPER",
    "x".repeat(64),
    "../etc/passwd",
    "acme corp",
  ];

  for (const slug of rejected) {
    assert.equal(isRoutableSlugShape(slug), false, slug);
  }
});

test("a missing workspace becomes a long-cached 404", () => {
  const decision = workspaceRoutingDecision(null);

  assert.equal(decision.status, 404);
  assert.deepEqual(decision.body, { error: "Unknown workspace" });
  // Enumeration noise must not come back to the origin every few minutes.
  assert.ok(decision.cacheSeconds >= 3600);
});

test("an active workspace is routable and exposes nothing but slug and status", () => {
  const decision = workspaceRoutingDecision({ slug: "acme", status: "active" });

  assert.equal(decision.status, 200);
  assert.deepEqual(decision.body, { slug: "acme", status: "active" });
  assert.deepEqual(Object.keys(decision.body).sort(), ["slug", "status"]);
});

test("a suspended workspace stays routable so the app can explain itself", () => {
  const decision = workspaceRoutingDecision({ slug: "acme", status: "suspended" });

  assert.equal(decision.status, 200);
  assert.equal(decision.body.status, "suspended");
});

test("hit responses are cached for a shorter window than misses", () => {
  const hit = workspaceRoutingDecision({ slug: "acme", status: "active" });
  const miss = workspaceRoutingDecision(null);

  // A new workspace must become reachable quickly; a bogus one need not.
  assert.ok(hit.cacheSeconds < miss.cacheSeconds);
});
