#!/usr/bin/env node
/**
 * Create Cloudflare "bypass" routes so high-volume hostnames stop invoking the
 * subdomain router.
 *
 * A Worker route created with no `script` field at all tells Cloudflare to run
 * no Worker for that pattern. Sending `script: ""` is rejected with "Cannot
 * configure a route for a Worker which does not exist". More-specific routes win over the `*.asystence.com/*` wildcard,
 * so `app.` and `www.` traffic — every HTML document and every hashed asset
 * chunk real users load — stops being billed as Worker requests.
 *
 * wrangler.toml cannot express this: routes declared there always bind to the
 * Worker being deployed.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... node setup-routes.mjs [--apply]
 *
 * Runs as a dry run by default and prints the changes it would make. The token
 * needs the "Workers Routes:Edit" permission on the zone.
 */

const ZONE_NAME = process.env.CF_ZONE_NAME || "asystence.com";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const APPLY = process.argv.includes("--apply");

// Hostnames that must never run the router. Keep in sync with
// DEFAULT_RESERVED / RESERVED_SUBDOMAINS in worker.js — that list makes the
// Worker pass them through, this list stops it being invoked at all.
const BYPASS_PATTERNS = [
  `app.${ZONE_NAME}/*`,
  `www.${ZONE_NAME}/*`,
  `api.${ZONE_NAME}/*`,
  `api-tunnel.${ZONE_NAME}/*`,
];

const API = "https://api.cloudflare.com/client/v4";

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = (body.errors || []).map((e) => e.message).join("; ");
    throw new Error(`${init.method || "GET"} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return body.result;
}

async function main() {
  if (!TOKEN) {
    console.error("CLOUDFLARE_API_TOKEN is required (needs Workers Routes:Edit).");
    process.exit(1);
  }

  const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!zones.length) throw new Error(`Zone ${ZONE_NAME} not found for this token`);
  const zoneId = zones[0].id;

  const existing = await cf(`/zones/${zoneId}/workers/routes`);
  console.log(`Zone ${ZONE_NAME} (${zoneId}) — ${existing.length} route(s) currently defined:`);
  for (const route of existing) {
    console.log(`  ${route.pattern} → ${route.script || "(no worker)"}`);
  }
  console.log("");

  for (const pattern of BYPASS_PATTERNS) {
    const match = existing.find((route) => route.pattern === pattern);

    if (match && !match.script) {
      console.log(`ok      ${pattern} already bypasses the Worker`);
      continue;
    }

    if (match) {
      console.log(`CHANGE  ${pattern} currently runs "${match.script}" — will unbind`);
      if (APPLY) {
        await cf(`/zones/${zoneId}/workers/routes/${match.id}`, {
          method: "PUT",
          body: JSON.stringify({ pattern }),
        });
        console.log(`        unbound`);
      }
      continue;
    }

    console.log(`CREATE  ${pattern} → (no worker)`);
    if (APPLY) {
      await cf(`/zones/${zoneId}/workers/routes`, {
        method: "POST",
        body: JSON.stringify({ pattern }),
      });
      console.log(`        created`);
    }
  }

  console.log("");
  console.log(APPLY ? "Applied." : "Dry run — re-run with --apply to make these changes.");
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
