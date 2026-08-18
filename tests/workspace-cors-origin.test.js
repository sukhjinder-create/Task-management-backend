// tests/workspace-cors-origin.test.js
//
// Hermetic self-test for which origins may call the API with credentials.
//
// Enabling workspace subdomains means the API must trust origins that are not
// in a fixed list. That is the exact change that turns a CORS policy into a
// vulnerability if it is written as a string suffix match, so the hostile cases
// are pinned here alongside the happy path.

import test from "node:test";
import assert from "node:assert/strict";

process.env.WORKSPACE_DOMAIN = "asystence.com";

const { isWorkspaceSubdomainOrigin } = await import("../config/environment.js");

test("a real workspace subdomain is trusted", () => {
  for (const origin of [
    "https://acme.asystence.com",
    "https://acme-corp.asystence.com",
    "https://a1.asystence.com",
  ]) {
    assert.equal(isWorkspaceSubdomainOrigin(origin), true, origin);
  }
});

test("lookalike domains are refused", () => {
  // Both of these "end with" asystence.com under a naive suffix check, and
  // both would otherwise be handed credentialed cross-origin access.
  assert.equal(isWorkspaceSubdomainOrigin("https://evil-asystence.com"), false);
  assert.equal(isWorkspaceSubdomainOrigin("https://asystence.com.evil.com"), false);
  assert.equal(isWorkspaceSubdomainOrigin("https://notasystence.com"), false);
});

test("plaintext http is refused", () => {
  // A workspace URL is always https; accepting http would let a network
  // attacker originate credentialed requests.
  assert.equal(isWorkspaceSubdomainOrigin("http://acme.asystence.com"), false);
});

test("nested labels are refused", () => {
  // Cloudflare's certificate covers one level, so a.b.<domain> cannot be a
  // real workspace -- and accepting it would widen the trusted set for free.
  assert.equal(isWorkspaceSubdomainOrigin("https://a.b.asystence.com"), false);
});

test("an explicit port is refused", () => {
  assert.equal(isWorkspaceSubdomainOrigin("https://acme.asystence.com:8443"), false);
});

test("the apex itself is not a workspace origin", () => {
  // It is trusted, but through the fixed allowlist -- not as a wildcard match.
  assert.equal(isWorkspaceSubdomainOrigin("https://asystence.com"), false);
});

test("garbage and empty input are refused rather than throwing", () => {
  for (const origin of ["", null, undefined, "not a url", "://", "javascript:alert(1)"]) {
    assert.equal(isWorkspaceSubdomainOrigin(origin), false, String(origin));
  }
});

test("no workspace domain configured means no wildcard is trusted", async () => {
  // The feature being off must not leave a wildcard open.
  const saved = process.env.WORKSPACE_DOMAIN;
  process.env.WORKSPACE_DOMAIN = "";
  try {
    assert.equal(isWorkspaceSubdomainOrigin("https://acme.asystence.com"), false);
  } finally {
    process.env.WORKSPACE_DOMAIN = saved;
  }
});
