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

test("a missing workspace 404s, and is cached only briefly", () => {
  const decision = workspaceRoutingDecision(null);

  assert.equal(decision.status, 404);
  assert.deepEqual(decision.body, { error: "Unknown workspace" });

  // Deliberately short. A long miss TTL does not deter enumeration -- every
  // probe uses a different slug, so every probe misses the cache anyway -- and
  // it kept newly created workspaces unreachable for an hour, twice, during
  // rollout. See MISS_CACHE_SECONDS in cloudflare-worker/worker.js.
  assert.ok(decision.cacheSeconds <= 120, `got ${decision.cacheSeconds}`);
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

test("a miss expires sooner than a hit, so new workspaces appear quickly", () => {
  const hit = workspaceRoutingDecision({ slug: "acme", status: "active" });
  const miss = workspaceRoutingDecision(null);

  // The relationship that matters: a slug probed before it existed must stop
  // reading as "unknown" quickly. A hit can be held longer -- a workspace that
  // exists is not about to stop existing.
  assert.ok(miss.cacheSeconds < hit.cacheSeconds, `miss=${miss.cacheSeconds} hit=${hit.cacheSeconds}`);
});
