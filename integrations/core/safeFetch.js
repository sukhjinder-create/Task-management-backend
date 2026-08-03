// integrations/core/safeFetch.js
//
// Outbound HTTP for admin-defined integrations.
//
// A workspace admin can point a custom provider at any URL, which makes this a
// server-side request forgery surface: without checks, "https://my-tool.example"
// could be swapped for 169.254.169.254 (cloud instance metadata → credentials),
// 127.0.0.1 (our own unauthenticated internal endpoints), or a private LAN host.
// Every outbound call for custom providers goes through here.

import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeUrlError";
    this.statusCode = 400;
  }
}

/** IPv4/IPv6 ranges that must never be reachable from a user-supplied URL. */
function isBlockedIp(ip) {
  const version = net.isIP(ip);
  if (!version) return true; // unresolvable → refuse rather than guess

  if (version === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    if (a === 0) return true;                       // "this network"
    if (a === 10) return true;                      // private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local — cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;        // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true;          // IETF protocol assignments
    if (a >= 224) return true;                      // multicast + reserved + broadcast
    return false;
  }

  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;   // unspecified / loopback
  if (normalized.startsWith("fe80")) return true;                  // link-local
  if (/^f[cd]/.test(normalized)) return true;                      // unique local
  if (normalized.startsWith("ff")) return true;                    // multicast
  // IPv4-mapped (::ffff:127.0.0.1) must be judged on the embedded IPv4 address.
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  return false;
}

/**
 * Validate a URL and resolve it to a concrete, allowed IP.
 *
 * Returns the resolved address so the caller can pin the connection to it —
 * re-resolving at request time would reopen a DNS-rebinding window where the
 * hostname resolves to a public IP during validation and a private one when the
 * request is actually made.
 */
export async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UnsafeUrlError("That does not look like a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new UnsafeUrlError(`Only http and https URLs are allowed (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Credentials embedded in the URL are not allowed — use the authentication fields instead.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // A literal IP needs no DNS lookup, but still needs checking.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new UnsafeUrlError(`Requests to ${hostname} are not allowed (private, loopback or link-local address).`);
    }
    return { url, address: hostname, family: net.isIP(hostname) };
  }

  if (/^localhost$/i.test(hostname) || /\.local$/i.test(hostname) || /\.internal$/i.test(hostname)) {
    throw new UnsafeUrlError(`Requests to ${hostname} are not allowed.`);
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve "${hostname}". Check the URL is reachable from the internet.`);
  }
  if (!records.length) throw new UnsafeUrlError(`Could not resolve "${hostname}".`);

  // Every resolved address must be safe: a hostname resolving to both a public
  // and a private IP must be refused, not silently allowed via the public one.
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new UnsafeUrlError(
        `"${hostname}" resolves to ${record.address}, which is a private or reserved address.`
      );
    }
  }

  return { url, address: records[0].address, family: records[0].family };
}

function buildAuth({ authType, authConfig = {} }, headers, url) {
  switch (authType) {
    case "bearer":
      if (authConfig.token) headers.Authorization = `Bearer ${authConfig.token}`;
      break;
    case "header":
      if (authConfig.header && authConfig.value) headers[authConfig.header] = authConfig.value;
      break;
    case "basic":
      if (authConfig.username != null) {
        const encoded = Buffer.from(`${authConfig.username}:${authConfig.password ?? ""}`).toString("base64");
        headers.Authorization = `Basic ${encoded}`;
      }
      break;
    case "query":
      if (authConfig.param && authConfig.value) url.searchParams.set(authConfig.param, authConfig.value);
      break;
    case "none":
    default:
      break;
  }
}

/**
 * Perform a guarded outbound request on behalf of a custom provider.
 *
 * Redirects are followed manually so each hop is re-validated — otherwise a
 * public URL could redirect to a private one and bypass the initial check.
 */
export async function safeFetchJson(rawUrl, {
  method = "GET",
  authType = "none",
  authConfig = {},
  headers: extraHeaders = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  redirectsRemaining = MAX_REDIRECTS,
} = {}) {
  const { url } = await assertSafeUrl(rawUrl);

  const headers = {
    Accept: "application/json",
    "User-Agent": "Asystence-Integration/1.0",
    ...extraHeaders,
  };
  buildAuth({ authType, authConfig }, headers, url);
  if (body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1000), 30_000));

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new Error(`The request to ${url.hostname} timed out.`);
    }
    throw new Error(`Could not reach ${url.hostname}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`${url.hostname} returned a redirect with no destination.`);
    if (redirectsRemaining <= 0) throw new UnsafeUrlError("Too many redirects.");
    // Re-validated on the next call — this is the DNS-rebinding / redirect bypass guard.
    return safeFetchJson(new URL(location, url).toString(), {
      method, authType, authConfig, headers: extraHeaders, body, timeoutMs,
      redirectsRemaining: redirectsRemaining - 1,
    });
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`Response from ${url.hostname} is too large (over 5 MB).`);
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Response from ${url.hostname} is too large (over 5 MB).`);
  }

  let data = null;
  let parseError = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    parseError = error.message;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    // Kept so the UI can show what actually came back when parsing fails.
    rawPreview: text.slice(0, 2000),
    parseError,
  };
}

export const __testables = { isBlockedIp, buildAuth };
