/**
 * Cloudflare Worker: workspace subdomain router.
 *
 * `*.asystence.com` is a wildcard DNS record, so this Worker is the only thing
 * standing between the public internet and an unbounded set of hostnames. It
 * proxies `<slug>.<root>` to the app and tags the response with the workspace
 * the visitor arrived through.
 *
 * The slug MUST be validated before proxying. Serving a 200 app shell for any
 * hostname anyone invents turns every subdomain guess into ~13 billed requests
 * (the HTML plus its hashed asset chunks), which is how a bot sweep exhausts a
 * daily Workers quota without a single real user involved.
 *
 * Environment bindings. Each falls back to its production value rather than
 * failing: the Worker fronts every hostname on the zone, so treating a missing
 * binding as fatal turns a config slip into a total outage of the domain. The
 * script that ran here before this one hardcoded these as constants and so
 * could never fail that way; these defaults keep that property while still
 * allowing an override.
 *   APP_DOMAIN   app.asystence.com       — proxy target
 *   ROOT_DOMAIN  asystence.com           — zone apex
 *   API_ORIGIN   https://api.asystence.com — slug resolution origin
 *   RESERVED_SUBDOMAINS      comma-separated; merged with DEFAULT_RESERVED
 *   WORKSPACE_SLUG_ALLOWLIST comma-separated; when set, resolves slugs from
 *                            this list alone and never calls API_ORIGIN
 *   SLUG_VALIDATION          "off" disables validation (emergency escape hatch)
 */

// Hostnames that must never be rewritten to the app: the apex and its aliases
// serve marketing, and `api` / `api-tunnel` are the backend itself — proxying
// either to the app has already caused one production outage.
const DEFAULT_RESERVED = [
  "app", "www", "api", "api-tunnel",
  "admin", "mail", "ftp", "cdn", "static", "assets",
];

// A slug is one DNS label: lowercase alphanumerics and inner hyphens. Anything
// else is rejected without touching the origin.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Fallbacks for unset bindings. See the note on environment bindings above:
// a 500 here would take down every hostname on the zone at once.
const DEFAULT_APP_DOMAIN = "app.asystence.com";
const DEFAULT_ROOT_DOMAIN = "asystence.com";
const DEFAULT_API_ORIGIN = "https://api.asystence.com";

// Bump to orphan every cached slug lookup at once.
//
// Slug results are cached at the edge, so a slug probed before it existed
// stays "not found" for the full miss TTL even after it is created. That is
// exactly what happened when slugs were first backfilled: workspaces whose
// names had been probed during debugging 404'd while untouched ones resolved.
// Waiting out an hour is not an option mid-rollout, and the Cache API has no
// purge -- but changing the key makes every old entry unreachable instantly.
const CACHE_KEY_VERSION = "v2";

const HIT_CACHE_SECONDS = 300;
const MISS_CACHE_SECONDS = 3600;

function csv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isValidSlugShape(slug) {
  return SLUG_PATTERN.test(slug);
}

function notFound(slug) {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Workspace not found</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0a0a0b; color:#e5e5e5;
         font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif }
  main { max-width:32rem; padding:2rem; text-align:center }
  h1 { font-size:1.25rem; margin:0 0 .5rem }
  p { margin:0; color:#a1a1a1 }
</style>
<main>
  <h1>Workspace not found</h1>
  <p>There is no workspace at this address. Check the link, or sign in and pick a workspace.</p>
</main>`;

  // Cached at the edge so a repeated sweep of the same bad hostname stops
  // reaching the Worker's origin lookup at all.
  return new Response(body, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=300, s-maxage=${MISS_CACHE_SECONDS}`,
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Is `slug` a real workspace?
 *
 * Answers from the edge cache when possible, then from API_ORIGIN. Returns
 * true on origin failure: a database blip must not black out every customer
 * subdomain, and the shape check above already absorbs the abusive traffic
 * this function exists to stop.
 */
async function slugIsRoutable(slug, env, ctx) {
  const allowlist = csv(env.WORKSPACE_SLUG_ALLOWLIST);
  if (allowlist.length) return allowlist.includes(slug);

  const apiOrigin = String(env.API_ORIGIN || DEFAULT_API_ORIGIN).trim().replace(/\/+$/, "");

  const cache = caches.default;
  const cacheKey = new Request(
    `https://${env.ROOT_DOMAIN}/__workspace-slug/${CACHE_KEY_VERSION}/${encodeURIComponent(slug)}`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) return cached.status === 200;

  let originStatus;
  try {
    const lookup = await fetch(
      `${apiOrigin}/public/workspaces/${encodeURIComponent(slug)}/exists`,
      { method: "GET", headers: { accept: "application/json" } }
    );
    originStatus = lookup.status;
  } catch (err) {
    console.error("[worker] slug lookup failed:", err?.message || err);
    return true;
  }

  // Only a definitive answer from the lookup endpoint is allowed to deny a
  // slug. Anything else -- 5xx, or the 401 this API returns for every unknown
  // path -- means we learned nothing about the slug, only that the endpoint is
  // not where we expected. Denying on that would 404 every customer subdomain
  // at once over a renamed route. Fail open and do not poison the cache.
  if (originStatus !== 200 && originStatus !== 404) {
    console.error(`[worker] unexpected slug lookup status ${originStatus} — failing open`);
    return true;
  }

  const routable = originStatus === 200;
  const ttl = routable ? HIT_CACHE_SECONDS : MISS_CACHE_SECONDS;
  const marker = new Response(null, {
    status: routable ? 200 : 404,
    headers: { "cache-control": `public, max-age=${ttl}` },
  });

  if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, marker.clone()));
  else await cache.put(cacheKey, marker.clone());

  return routable;
}

export default {
  async fetch(request, env, ctx) {
    const appDomain = String(env.APP_DOMAIN || DEFAULT_APP_DOMAIN).trim();
    const rootDomain = String(env.ROOT_DOMAIN || DEFAULT_ROOT_DOMAIN).trim().toLowerCase();

    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    // Apex, and anything outside the zone, pass through untouched.
    if (hostname === rootDomain || !hostname.endsWith(`.${rootDomain}`)) {
      return fetch(request);
    }

    const subdomain = hostname.slice(0, -1 * (rootDomain.length + 1));
    const reserved = new Set([...DEFAULT_RESERVED, ...csv(env.RESERVED_SUBDOMAINS)]);
    if (reserved.has(subdomain)) {
      return fetch(request);
    }

    // Multi-label hosts (`a.b.example.com`) and junk both fail here, costing
    // one Worker invocation and zero subrequests.
    if (!isValidSlugShape(subdomain)) {
      return notFound(subdomain);
    }

    if (String(env.SLUG_VALIDATION || "").trim().toLowerCase() !== "off") {
      const routable = await slugIsRoutable(subdomain, env, ctx);
      if (!routable) return notFound(subdomain);
    }

    const targetUrl = new URL(url.pathname + url.search, `https://${appDomain}`);
    const proxiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    const response = await fetch(proxiedRequest);
    const proxiedResponse = new Response(response.body, response);

    // Only documents need the cookie; repeating it on every hashed asset just
    // inflates headers and defeats caching of those assets.
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      proxiedResponse.headers.append(
        "Set-Cookie",
        `workspace_slug=${subdomain}; Domain=.${rootDomain}; Path=/; SameSite=Lax; Secure`
      );
    }

    // Workspace subdomains are private app surfaces. Keeping them out of search
    // indexes stops crawlers discovering and re-crawling the wildcard space.
    proxiedResponse.headers.set("x-robots-tag", "noindex, nofollow");

    return proxiedResponse;
  },
};
