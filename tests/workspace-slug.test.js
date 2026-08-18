// tests/workspace-slug.test.js
//
// Hermetic self-test for slug derivation and validation. No DB, no network --
// only the pure functions. Uniqueness is not covered here because it is a
// database property; these tests pin the rules that decide what a slug may be.
//
// A slug becomes a hostname, so the stakes are higher than a display field: a
// slug colliding with `api` puts a tenant on the backend's hostname.

import test from "node:test";
import assert from "node:assert/strict";

import { slugify, validateSlug } from "../services/workspaceSlug.service.js";
import { isReservedSlug, reservedSlugs } from "../config/reservedSlugs.js";

test("slugify turns display names into DNS labels", () => {
  assert.equal(slugify("Acme Corp"), "acme-corp");
  assert.equal(slugify("  Hello---World  "), "hello-world");
  assert.equal(slugify("ApyHub"), "apyhub");
  assert.equal(slugify("Foo & Bar, Inc."), "foo-bar-inc");
});

test("slugify keeps the base letter of accented Latin rather than dropping it", () => {
  // "Café Münich" losing its accented characters entirely would yield "caf-nich".
  assert.equal(slugify("Café Münich"), "cafe-munich");
});

test("slugify yields empty for names with no ASCII to work with", () => {
  // The caller must fall back rather than invent a slug from nothing.
  assert.equal(slugify("日本語"), "");
  assert.equal(slugify("!!!"), "");
});

test("slugify never exceeds the DNS label limit or ends in a hyphen", () => {
  const long = slugify("x".repeat(200));
  assert.ok(long.length <= 63, `got ${long.length}`);
  assert.ok(!long.endsWith("-"));

  const truncated = slugify(`${"a".repeat(60)} corp`);
  assert.ok(!truncated.endsWith("-"), truncated);
});

test("validateSlug accepts ordinary workspace slugs", () => {
  for (const slug of ["acme", "acme-corp", "a1b2", "x".repeat(63)]) {
    assert.equal(validateSlug(slug), null, slug);
  }
});

test("validateSlug rejects anything that cannot be a DNS label", () => {
  for (const slug of ["", "ab", "-lead", "trail-", "under_score", "a.b", "x".repeat(64), "has space"]) {
    assert.ok(validateSlug(slug), `expected rejection for ${JSON.stringify(slug)}`);
  }
});

test("infrastructure hostnames can never be claimed as slugs", () => {
  // Routing a backend subdomain to the frontend has taken this product down
  // once already; a tenant must not be able to do it by naming themselves.
  for (const slug of ["api", "api-tunnel", "app", "www", "admin", "cdn"]) {
    assert.ok(validateSlug(slug), `${slug} must be reserved`);
    assert.equal(isReservedSlug(slug), true, slug);
  }
});

test("reserved matching is case-insensitive", () => {
  assert.equal(isReservedSlug("API"), true);
  assert.equal(isReservedSlug("  Api  "), true);
});

test("punycode prefix is refused", () => {
  // xn-- is the IDNA ACE prefix: allowing it lets a tenant claim a hostname
  // that renders as arbitrary Unicode in the browser's address bar.
  assert.ok(validateSlug("xn--80ak6aa92e"));
});

test("the Worker's reserved hostnames are a subset of the backend's list", () => {
  // The edge answers without consulting the database, so its list is separate.
  // If they disagree, the backend can mint a slug the edge refuses to route.
  const workerReserved = ["app", "www", "api", "api-tunnel", "admin", "mail", "ftp", "cdn", "static", "assets"];
  const backend = reservedSlugs();
  for (const slug of workerReserved) {
    assert.equal(backend.has(slug), true, `${slug} is reserved at the edge but not in the backend list`);
  }
});

test("a batch never issues the same slug twice", async () => {
  // Regression: the backfill's dry run showed two workspaces both getting
  // "apyhub", because uniqueness was checked only against what the database
  // could see and a dry run writes nothing. A preview that disagrees with the
  // real run is worse than no preview -- the operator approves one thing and
  // something else happens.
  const { generateUniqueSlug } = await import("../services/workspaceSlug.service.js");

  // Stands in for a database that never sees the writes, which is exactly the
  // dry-run case and also any batch that commits only at the end.
  const client = { query: async () => ({ rows: [] }) };
  const claimed = new Set();

  const slugs = [];
  for (const name of ["Apyhub", "apyhub", "APYHUB"]) {
    slugs.push(await generateUniqueSlug(name, { client, claimed }));
  }

  assert.deepEqual(slugs, ["apyhub", "apyhub-2", "apyhub-3"]);
  assert.equal(new Set(slugs).size, slugs.length, "slugs must be distinct");
});

test("a batch also avoids slugs that already exist in the database", async () => {
  const { generateUniqueSlug } = await import("../services/workspaceSlug.service.js");

  // Seeded the way the runner seeds it: from the slugs already stored.
  const claimed = new Set(["acme"]);
  const client = { query: async () => ({ rows: [] }) };

  assert.equal(await generateUniqueSlug("Acme", { client, claimed }), "acme-2");
});
