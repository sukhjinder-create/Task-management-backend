# Runbook — wildcard subdomain router & Workers request budget

## The problem this fixes

`*.asystence.com` is a wildcard DNS record fronted by one Cloudflare Worker
(`cloudflare-worker/worker.js`). The original router never checked whether a
subdomain corresponded to a real workspace — it proxied anything that was not
`app`, `www`, or the apex straight to the app.

Observed before the fix:

```
$ curl -I https://zz-nonexistent-test.asystence.com/
HTTP/1.1 200 OK
Set-Cookie: workspace_slug=zz-nonexistent-test; Domain=.asystence.com; ...
```

Three multipliers turned that into an exhausted free-plan quota (100,000
Worker requests/day):

1. **Fan-out.** The returned HTML references 12 assets on the same host, so one
   bogus hostname cost ~13 billed Worker requests, not one.
2. **Infinite paths.** `vercel.json` rewrites `/(.*)` to `index.html`, so every
   path on every subdomain answered 200. A crawler never hits a 404 and never
   stops.
3. **No robots policy.** The app had no `robots.txt`, so the SPA rewrite served
   `index.html` for it too — the only effective directive was `Allow: /`.

Subdomain enumeration is routine bot behaviour; against that surface it does not
take real users to reach 100k/day.

## What changed

| Change | File |
| --- | --- |
| Slug validated before proxying; unknown/malformed hosts get a static 404 with no asset fan-out | `cloudflare-worker/worker.js` |
| Unauthenticated slug-resolution endpoint for the edge | `routes/publicWorkspace.routes.js` |
| Case-insensitive slug lookup (uses `idx_workspaces_slug`) | `repositories/workspace.repository.js` |
| Worker config + documented bindings | `cloudflare-worker/wrangler.toml` |
| Bypass-route provisioning script | `cloudflare-worker/setup-routes.mjs` |
| `Disallow: /` for the app and all workspace hosts | frontend `public/robots.txt` |

Behaviour is unchanged for real workspaces. Suspended workspaces still resolve,
so the app keeps rendering its own suspension messaging rather than a bare edge
404.

## Deploy order

Deploy the backend first. The Worker calls the new endpoint, and until it
exists every lookup returns a non-200 — the Worker fails open, so nothing
breaks, but nothing is filtered either.

1. **Backend** — push to `ai-platform-epic-a`; the `deploy-selfhosted.yml`
   workflow rebuilds on the host and auto-rolls back if health checks fail.
   Verify:

   ```
   curl -i https://api.asystence.com/public/workspaces/<real-slug>/exists   # 200
   curl -i https://api.asystence.com/public/workspaces/zz-nope/exists       # 404
   ```

2. **Worker** — the live Worker is `asystence-workspace-router` on zone
   `asystence.com` (`c08190129d32f387f331e3533cd2a108`), which is what
   `wrangler.toml` targets; changing that name publishes a second Worker while
   the old one keeps serving traffic. Confirm the vars `APP_DOMAIN`,
   `ROOT_DOMAIN`, and `API_ORIGIN` are bound. Then:

   ```
   cd cloudflare-worker && npx wrangler deploy
   ```

   Verify:

   ```
   curl -I https://zz-nonexistent-test.asystence.com/   # expect 404
   curl -I https://<real-slug>.asystence.com/           # expect 200 + workspace_slug cookie
   curl -I https://api.asystence.com/health             # unchanged
   ```

3. **Bypass routes** — dry run, then apply. The server already holds a
   Cloudflare API token at `~/.cloudflare-api-token` (chmod 600); it needs
   `Workers Routes:Edit` added if it does not have it yet.

   ```
   CLOUDFLARE_API_TOKEN=... node cloudflare-worker/setup-routes.mjs
   CLOUDFLARE_API_TOKEN=... node cloudflare-worker/setup-routes.mjs --apply
   ```

4. **Frontend** — deploy, then confirm `curl https://app.asystence.com/robots.txt`
   returns the file rather than the app shell.

## What each change is worth

- **Bypass routes** are the only change that removes Worker *invocations*
  outright. `app.` and `www.` match the `*.asystence.com/*` wildcard today and
  are billed one request per document and per asset, purely to be passed
  through. On normal user traffic this is the largest single saving.
- **Slug validation** does not stop the Worker running for a bad hostname — a
  Worker response cannot prevent its own invocation. It removes the ~13× asset
  fan-out behind each one, so bot sweeps cost 1 request instead of ~13.
- **`robots.txt` + `X-Robots-Tag`** stop legitimate crawlers discovering and
  re-crawling the wildcard space at all.

If abusive traffic persists after this, the next lever is a WAF or rate-limiting
rule: those run *before* Workers and are the only way to make an unwanted
request cost nothing.

## Rollback

Set `SLUG_VALIDATION = "off"` in the Worker vars and redeploy — the router
reverts to unconditional proxying without touching the origin. Use this only if
slug resolution itself is causing an outage; the Worker already fails open when
the lookup endpoint returns 5xx or is unreachable.

## Operational notes

- Positive lookups are edge-cached 300s, negatives 3600s. A newly created
  workspace can therefore take up to 5 minutes to route if its slug was probed
  while it did not exist.
- `WORKSPACE_SLUG_ALLOWLIST` (comma-separated) bypasses the origin entirely and
  resolves from that list alone — a stopgap if the backend is unavailable.
- `DEFAULT_RESERVED` in `worker.js` must always contain `api` and `api-tunnel`.
  Proxying either to the app takes the whole product down — this has happened
  once already. Add new non-workspace subdomains to `RESERVED_SUBDOMAINS` in the
  Worker vars *and* to `BYPASS_PATTERNS` in `setup-routes.mjs`.
