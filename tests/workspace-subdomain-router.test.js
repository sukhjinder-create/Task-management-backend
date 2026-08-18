// tests/workspace-subdomain-router.test.js
//
// Hermetic self-test for the Cloudflare subdomain router. No network: global
// fetch and the edge cache are stubbed, so every assertion is about the routing
// decision itself.
//
// The property under test is a cost property as much as a correctness one. The
// original router served a 200 app shell for any hostname, and each shell pulls
// ~12 hashed asset chunks through the same Worker — so one bogus subdomain cost
// ~13 billed requests. These tests pin down that unknown and malformed hosts
// terminate at the edge, and that legitimate ones still reach the app.

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../cloudflare-worker/worker.js";

const ENV = {
  APP_DOMAIN: "app.asystence.com",
  ROOT_DOMAIN: "asystence.com",
  API_ORIGIN: "https://api.asystence.com",
};

/**
 * Drives the Worker with a recording fetch stub and an empty edge cache.
 *
 * `routes` maps a URL substring to the Response the stub should return; the
 * recorded call list is what proves a request never left the edge.
 */
async function run(url, { env = ENV, routes = {}, cacheSeed = null } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;

  const store = new Map();
  if (cacheSeed) store.set(cacheSeed.key, cacheSeed.response);

  globalThis.caches = {
    default: {
      async match(request) {
        return store.get(new URL(request.url).pathname) || undefined;
      },
      async put(request, response) {
        store.set(new URL(request.url).pathname, response);
      },
    },
  };

  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : input.url;
    calls.push(target);
    for (const [fragment, response] of Object.entries(routes)) {
      if (target.includes(fragment)) return response();
    }
    return new Response("app shell", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  try {
    const ctx = { waitUntil: (promise) => promise };
    const response = await worker.fetch(new Request(url), env, ctx);
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

const lookupHit = () => new Response(JSON.stringify({ slug: "acme", status: "active" }), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const lookupMiss = () => new Response(JSON.stringify({ error: "Unknown workspace" }), {
  status: 404,
  headers: { "content-type": "application/json" },
});

test("apex passes through without a slug lookup", async () => {
  const { response, calls } = await run("https://asystence.com/");
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("/public/workspaces/"));
});

test("reserved subdomains pass through untouched", async () => {
  // `api` and `api-tunnel` are the backend itself; rewriting either to the app
  // has already caused one production outage.
  for (const host of ["app", "www", "api", "api-tunnel"]) {
    const { response, calls } = await run(`https://${host}.asystence.com/`);
    assert.equal(response.status, 200, host);
    assert.equal(calls.length, 1, host);
    assert.ok(!calls[0].includes("/public/workspaces/"), host);
    assert.equal(response.headers.get("set-cookie"), null, host);
  }
});

test("malformed hosts 404 without touching the origin", async () => {
  // Nested labels, underscores and over-long labels are all shapes no workspace
  // slug can take, so they must not cost a subrequest.
  const hosts = [
    "a.b.asystence.com",
    "under_score.asystence.com",
    "-leading.asystence.com",
    `${"x".repeat(64)}.asystence.com`,
  ];

  for (const host of hosts) {
    const { response, calls } = await run(`https://${host}/`);
    assert.equal(response.status, 404, host);
    assert.equal(calls.length, 0, `${host} must issue zero subrequests`);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", host);
  }
});

test("unknown slug 404s and never fetches the app shell", async () => {
  const { response, calls } = await run("https://zz-nonexistent-test.asystence.com/", {
    routes: { "/public/workspaces/": lookupMiss },
  });

  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("/public/workspaces/zz-nonexistent-test/exists"));
  assert.ok(!calls.some((call) => call.includes("app.asystence.com")));
});

test("asset paths on an unknown slug also stop at the edge", async () => {
  const { response, calls } = await run(
    "https://zz-nonexistent-test.asystence.com/assets/vendor-react-ButrDCAb.js",
    { routes: { "/public/workspaces/": lookupMiss } }
  );

  assert.equal(response.status, 404);
  assert.ok(!calls.some((call) => call.includes("app.asystence.com")));
});

test("known slug proxies to the app and tags the document", async () => {
  const { response, calls } = await run("https://acme.asystence.com/projects", {
    routes: { "/public/workspaces/": lookupHit },
  });

  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call === "https://app.asystence.com/projects"));
  assert.match(response.headers.get("set-cookie") || "", /workspace_slug=acme/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("non-document responses are not given a workspace cookie", async () => {
  const { response } = await run("https://acme.asystence.com/assets/index.js", {
    routes: {
      "/public/workspaces/": lookupHit,
      "app.asystence.com": () => new Response("console.log(1)", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      }),
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a cached negative result answers without re-asking the origin", async () => {
  const { response, calls } = await run("https://zz-cached.asystence.com/", {
    cacheSeed: {
      key: "/__workspace-slug/zz-cached",
      response: new Response(null, { status: 404 }),
    },
  });

  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test("origin failure fails open so a database blip cannot black out customers", async () => {
  const { response, calls } = await run("https://acme.asystence.com/", {
    routes: { "/public/workspaces/": () => new Response("boom", { status: 503 }) },
  });

  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call.includes("app.asystence.com")));
});

test("allowlist mode resolves slugs without any origin call", async () => {
  const env = { ...ENV, WORKSPACE_SLUG_ALLOWLIST: "acme, globex" };

  const allowed = await run("https://globex.asystence.com/", { env });
  assert.equal(allowed.response.status, 200);
  assert.ok(!allowed.calls.some((call) => call.includes("/public/workspaces/")));

  const denied = await run("https://initech.asystence.com/", { env });
  assert.equal(denied.response.status, 404);
  assert.equal(denied.calls.length, 0);
});

test("SLUG_VALIDATION=off restores unconditional proxying", async () => {
  const { response, calls } = await run("https://anything.asystence.com/", {
    env: { ...ENV, SLUG_VALIDATION: "off" },
  });

  assert.equal(response.status, 200);
  assert.ok(!calls.some((call) => call.includes("/public/workspaces/")));
});
