# Runbook — workspace subdomains (`<slug>.asystence.com`)

## What this is

Each workspace is reachable at its own hostname. `acme.asystence.com` serves the
same SPA as `app.asystence.com`, with the workspace identified by the hostname.

**One label only.** `acme.asystence.com` works; `app.acme.asystence.com` cannot,
and never could — Cloudflare's Universal SSL covers `asystence.com` and
`*.asystence.com`, one level deep. A two-level host fails the TLS handshake
before any of our code runs. Supporting it needs Advanced Certificate Manager,
a paid add-on. Don't.

## The pieces

| Layer | What it does |
| --- | --- |
| `config/reservedSlugs.js` | Labels no workspace may claim |
| `services/workspaceSlug.service.js` | Derivation + validation |
| `run-workspace-slug-backfill-migration.js` | Assigns slugs to existing workspaces |
| `config/environment.js` | Which origins CORS trusts |
| `services/authHandoff.service.js` | Cross-origin session handoff |
| `cloudflare-worker/worker.js` | Routes the hostname, 404s unknown slugs |

## Two things that are load-bearing

**A slug is a hostname, not a label.** A workspace named "API" slugging to `api`
would put a tenant on the backend's hostname. Routing a backend subdomain to the
frontend has taken this product down once already. `config/reservedSlugs.js` is
the source of truth, and `cloudflare-worker/worker.js` keeps its own copy
because the edge answers without a database — **if you add a reserved label,
add it to both.** A test asserts the Worker's list is a subset of the backend's.

**Sessions never travel in the URL.** `app.<domain>` and `<slug>.<domain>` are
separate origins, so localStorage does not follow the user. The redirect carries
a single-use code with a 60s TTL, exchanged for tokens over POST. This replaced
a design that put the access *and refresh* token in the query string, which
published them to browser history, Referer headers and every access log in the
path. If you are ever tempted to "just pass the token" — that is the bug this
exists to prevent.

## Enabling it

Order matters. Each step is safe to stop at.

1. **Create the handoff table**
   ```
   docker exec <app-container> node run-auth-handoff-migration.js
   ```

2. **Backfill slugs** — dry run first; it prints what it would assign.
   ```
   docker exec <app-container> node run-workspace-slug-backfill-migration.js
   docker exec <app-container> node run-workspace-slug-backfill-migration.js --apply
   ```
   Idempotent: workspaces that already have a slug are left alone, because a
   slug is a published hostname and rewriting one breaks every link to it.
   Existing slugs that are not routable are reported, not silently fixed.

3. **Backend** — add to `~/app/.env`, then restart:
   ```
   WORKSPACE_DOMAIN=asystence.com
   ```
   This is what makes CORS trust `https://<slug>.asystence.com`. Until it is
   set, no wildcard origin is trusted at all — the safe default.

   **Restart with `IMAGE_REF` set, always:**
   ```
   cd ~/app
   IMAGE_REF=ghcr.io/sukhjinder-create/task-management-backend:<commit-sha>      docker compose -f docker-compose.prod.yml up -d --force-recreate app
   ```
   `docker-compose.prod.yml` declares `image: ${IMAGE_REF:-app-app:latest}`, and
   CI supplies `IMAGE_REF` at deploy time. A bare `docker compose up` therefore
   silently falls back to a **stale local `app-app:latest`** and rolls
   production back several commits — it did exactly that during this rollout,
   and the only symptom was CORS quietly refusing workspace origins while the
   app kept answering 200. `docker images` lists the SHA-tagged images; use the
   newest, and confirm afterwards:
   ```
   docker inspect -f '{{.Config.Image}}' $(docker ps -qf name=app-app-1)
   ```

4. **Frontend** — set `VITE_WORKSPACE_DOMAIN=asystence.com` in the Vercel
   project, then `vercel --prod`. This is the switch that starts redirecting
   users. Note the project has **no git integration**; pushing does not deploy.

5. **Verify**
   ```
   curl -s https://api.asystence.com/public/workspaces/<slug>/exists   # 200
   curl -I https://<slug>.asystence.com/                              # 200
   curl -I https://zz-nope.asystence.com/                             # 404
   ```
   Then sign in at `app.asystence.com` and confirm you land on
   `<slug>.asystence.com` with **no `_hc` or `_t` left in the address bar**,
   and that chat connects (that exercises Socket.IO's CORS).

## Rolling back

Unset `VITE_WORKSPACE_DOMAIN` and redeploy the frontend. Redirects stop
immediately; everything keeps working on `app.asystence.com`. The backend can
keep `WORKSPACE_DOMAIN` set — it only widens CORS, it does not route anyone.

Do **not** roll back by clearing slugs. The edge 404s any slug it cannot
resolve, so emptying the column makes every workspace hostname dead while the
frontend is still sending people there.

## Operating notes

- Slug lookups are edge-cached: 300s on a hit, 3600s on a miss. **A slug probed
  before it existed stays "not found" for the full hour.** That bit this
  rollout: `apyhub` and `razorpay` had been probed during debugging and 404'd
  at the edge while untouched slugs resolved. The Cache API has no purge and
  redeploying the Worker does not clear it — bump `CACHE_KEY_VERSION` in
  `cloudflare-worker/worker.js` and redeploy to orphan every entry at once.
- Handoff codes are single-use with a 60s TTL. "Invalid or expired code" is
  returned for unknown, expired and already-spent alike — that is deliberate,
  so the endpoint cannot be used to probe.
- `auth_handoff_codes` grows with every redirect. `purgeExpiredHandoffCodes()`
  clears spent and expired rows; wire it to the existing cron if the table
  becomes noticeable.
