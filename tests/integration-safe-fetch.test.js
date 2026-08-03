import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, UnsafeUrlError, __testables } from "../integrations/core/safeFetch.js";

const { isBlockedIp, buildAuth } = __testables;

test("cloud metadata and loopback addresses are blocked", () => {
  // 169.254.169.254 is the AWS/GCP/Azure instance metadata endpoint — reaching it
  // from a user-supplied URL would leak the server's cloud credentials.
  assert.equal(isBlockedIp("169.254.169.254"), true, "cloud metadata endpoint");
  assert.equal(isBlockedIp("127.0.0.1"), true, "loopback");
  assert.equal(isBlockedIp("0.0.0.0"), true);
  assert.equal(isBlockedIp("::1"), true, "IPv6 loopback");
  assert.equal(isBlockedIp("::"), true);
  // IPv4-mapped IPv6 must be judged on the embedded address, not the prefix.
  assert.equal(isBlockedIp("::ffff:127.0.0.1"), true, "IPv4-mapped loopback");
  assert.equal(isBlockedIp("::ffff:169.254.169.254"), true, "IPv4-mapped metadata");
});

test("private and reserved ranges are blocked", () => {
  for (const ip of [
    "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "192.168.1.1",
    "100.64.0.1",          // carrier-grade NAT
    "224.0.0.1",           // multicast
    "255.255.255.255",     // broadcast
    "fe80::1",             // IPv6 link-local
    "fc00::1", "fd00::1",  // IPv6 unique-local
    "ff02::1",             // IPv6 multicast
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
  }
});

test("genuinely public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} must be allowed`);
  }
});

test("addresses just outside private ranges are not over-blocked", () => {
  // Off-by-one errors here would break legitimate customer tools.
  assert.equal(isBlockedIp("172.15.255.255"), false, "just below 172.16");
  assert.equal(isBlockedIp("172.32.0.0"), false, "just above 172.31");
  assert.equal(isBlockedIp("11.0.0.1"), false, "just above 10.x");
  assert.equal(isBlockedIp("192.167.0.1"), false);
});

test("malformed input is refused rather than guessed at", () => {
  for (const bad of ["not-an-ip", "", null, undefined, "999.999.999.999", "1.2.3"]) {
    assert.equal(isBlockedIp(bad), true, `${bad} must be refused`);
  }
});

test("only http(s) URLs without embedded credentials are accepted", async () => {
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), UnsafeUrlError, "file scheme");
  await assert.rejects(() => assertSafeUrl("gopher://x.com"), UnsafeUrlError, "gopher scheme");
  await assert.rejects(() => assertSafeUrl("ftp://x.com"), UnsafeUrlError, "ftp scheme");
  await assert.rejects(() => assertSafeUrl("not a url"), UnsafeUrlError);
  // Credentials in the URL would be silently logged/stored; force them through
  // the auth fields instead.
  await assert.rejects(() => assertSafeUrl("https://user:pass@example.com"), UnsafeUrlError);
});

test("localhost and internal hostnames are blocked without needing DNS", async () => {
  await assert.rejects(() => assertSafeUrl("http://localhost/admin"), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl("http://LOCALHOST:8080"), UnsafeUrlError, "case-insensitive");
  await assert.rejects(() => assertSafeUrl("http://printer.local"), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl("http://db.internal"), UnsafeUrlError);
});

test("literal private IPs in a URL are rejected", async () => {
  await assert.rejects(() => assertSafeUrl("http://127.0.0.1:5000/health"), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data/"), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl("http://10.0.0.5/internal"), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl("http://[::1]:3000/"), UnsafeUrlError);
});

test("auth schemes build the right headers and never leak into the wrong place", () => {
  let headers = {}; let url = new URL("https://x.com");
  buildAuth({ authType: "bearer", authConfig: { token: "t0k" } }, headers, url);
  assert.equal(headers.Authorization, "Bearer t0k");

  headers = {}; url = new URL("https://x.com");
  buildAuth({ authType: "header", authConfig: { header: "X-Api-Key", value: "k" } }, headers, url);
  assert.equal(headers["X-Api-Key"], "k");
  assert.equal(headers.Authorization, undefined);

  headers = {}; url = new URL("https://x.com");
  buildAuth({ authType: "basic", authConfig: { username: "u", password: "p" } }, headers, url);
  assert.equal(headers.Authorization, `Basic ${Buffer.from("u:p").toString("base64")}`);

  headers = {}; url = new URL("https://x.com");
  buildAuth({ authType: "query", authConfig: { param: "api_key", value: "abc" } }, headers, url);
  assert.equal(url.searchParams.get("api_key"), "abc");
  assert.equal(Object.keys(headers).length, 0, "query auth must not set headers");

  // Missing credentials must not produce a malformed "Bearer undefined".
  headers = {}; url = new URL("https://x.com");
  buildAuth({ authType: "bearer", authConfig: {} }, headers, url);
  assert.equal(headers.Authorization, undefined);

  headers = {}; url = new URL("https://x.com");
  buildAuth({ authType: "none", authConfig: {} }, headers, url);
  assert.equal(Object.keys(headers).length, 0);
});
