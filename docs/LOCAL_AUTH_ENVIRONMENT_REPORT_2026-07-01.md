# Local Authentication Environment Report

Date: 2026-07-01

## Root Cause

Local auth was not isolated because the backend Google OAuth callback and database settings were production values in the local environment.

- `routes/auth.routes.js` builds the Google authorization request with `redirect_uri: GOOGLE_CALLBACK_URL`.
- `services/auth.service.js` exchanges Google codes with the same callback URL.
- The previous local backend `.env` set `GOOGLE_CALLBACK_URL` to the production Cloud Run callback, so `localhost -> Login with Google -> Google -> production backend -> production frontend`.
- The previous local backend `.env` also pointed `DATABASE_URL` / `DB_HOST` at the production Supabase host, so local email auth could mutate production data even when the browser stayed on localhost.

## Production Dependencies Found

- Backend local `.env`: production Google callback URL.
- Backend local `.env`: production Supabase database host.
- Frontend Electron config: hardcoded production Cloud Run API URL.
- Frontend app: workspace redirects hardcoded to production app/domain.
- Frontend app: scattered API fallbacks and empty env values could bypass the intended local API URL.
- Mobile config: defaulted to production web/API URLs.
- AI service `.env`: production Supabase values and local backend port mismatch.
- Migration scripts: hardcoded database connection strings.
- Cloudflare worker: hardcoded production app/root domains.

Remaining production references are intentional only:

- Deployment metadata: `deploy-cloudrun.sh`, `/version` service label.
- Runtime deny-lists: frontend and AI local guards, backend database safety guard.
- Documentation and runbooks.

## Configuration Corrected

- Added backend `config/environment.js` as the source of truth for app env, frontend URL, backend public URL, Google callback URL, mobile callback URL, CORS origins, and dev-auth enablement.
- Backend CORS and socket origins now come from environment config.
- Backend OAuth callback generation now resolves to `http://localhost:5000/auth/google/callback` locally.
- Backend password reset, payment redirects, Asana OAuth return URLs, and email app links now use environment config.
- Backend `POST /auth/dev-login` provides an intentional local developer auth path when OAuth credentials are not configured.
- Backend database safety now blocks local/staging runtimes from using known production DB hosts unless explicitly overridden.
- Backend DB pool now honors `DB_SSL=false` for local `DATABASE_URL`, while preserving SSL-by-default for non-local DB URLs.
- Added `docker-compose.local.yml` to bootstrap local Postgres with `schema_dump.sql` plus the missing additive migrations needed by current auth/runtime code.
- Frontend `src/config/runtime.js` centralizes API/socket URLs, dev-auth flag, workspace-domain redirects, and localhost production-API refusal.
- Frontend auth pages and API/socket services now use the runtime config instead of production fallbacks.
- Electron, mobile, AI service, migration scripts, and Cloudflare worker were moved to environment-driven URLs.

## Environment Variables

Local backend now uses:

- `APP_ENV=development`
- `NODE_ENV=development`
- `PORT=5000`
- `FRONTEND_URL=http://localhost:5173`
- `API_PUBLIC_URL=http://localhost:5000`
- `CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174`
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/asystence_dev`
- `DB_SSL=false`
- `AUTH_DEV_MODE=true`
- `GOOGLE_CALLBACK_URL=http://localhost:5000/auth/google/callback`
- `TRIAL_SIGNUP_REQUIRE_PAYMENT=false`
- `AI_SERVICE_URL=http://localhost:5005/internal/chat-event`

Local frontend now uses:

- `VITE_API_URL=http://localhost:5000`
- `VITE_API_BASE_URL=http://localhost:5000`
- `VITE_BACKEND_URL=http://localhost:5000`
- `VITE_SOCKET_URL=http://localhost:5000`
- `VITE_AUTH_DEV_MODE=true`
- `VITE_ALLOW_LOCAL_PRODUCTION_API=false`
- `VITE_APP_PRIMARY_HOST=` blank locally
- `VITE_WORKSPACE_DOMAIN=` blank locally

Local AI service now uses:

- `APP_ENV=development`
- `AI_PORT=5005`
- `BACKEND_BASE_URL=http://localhost:5000`
- `MAIN_BACKEND_URL=http://localhost:5000`
- `AI_SERVICE_SECRET=local-ai-service-secret`

## Local Validation

Validated locally with Docker Postgres, backend, and frontend:

- Local Postgres: `asystence-local-postgres` healthy on `localhost:5432`.
- Schema restored: 122 public tables plus auth/runtime migrations.
- Backend env resolved to frontend `http://localhost:5173`, backend `http://localhost:5000`, Google callback `http://localhost:5000/auth/google/callback`, dev auth enabled.
- AI env resolved to backend `http://localhost:5000`.
- Frontend Vite served the main app on `http://127.0.0.1:5173`.
- Backend CORS preflight for `Origin: http://localhost:5173` returned `204` with `Access-Control-Allow-Origin: http://localhost:5173`.
- Local production DB guard blocked the production Supabase host in development with `DATABASE_SAFETY_GUARD_BLOCKED`.
- Frontend source scan found production domains only in the localhost safety deny-list.
- AI source scan found production domains only in the localhost safety deny-list.

Auth endpoint smoke results:

- Developer login: OK on `localhost:5000`.
- Logout: OK on `localhost:5000`.
- Registration: OK on `localhost:5000`.
- Email login: OK on `localhost:5000`.
- Forgot password: OK on `localhost:5000`.
- Reset password: OK on `localhost:5000`.
- Login after reset: OK on `localhost:5000`.
- Google OAuth: intentionally unavailable because local Google client credentials are blank; `/auth/google` returns `503 {"error":"Google SSO is not configured"}` instead of redirecting to production.

## Regression Results

- `npm run build` passed for the frontend.
- Backend syntax checks passed for changed auth/env/database files.
- AI-service syntax checks passed for changed config/service files.
- `docker compose -f docker-compose.local.yml config` passed.
- Production behavior remains environment-driven. `AUTH_DEV_MODE` is ignored in production, and production/staging deployments can still supply production URLs via environment variables.

## Local Run Path

From the backend repo:

```powershell
docker compose -f docker-compose.local.yml up -d postgres
npm run dev
```

From the frontend repo:

```powershell
npm run dev
```

Optional AI service:

```powershell
npm start
```

Final confirmation: local auth now runs against localhost services and local Postgres. It does not redirect to `app.asystence.com`, does not call the production backend, and the backend refuses known production database hosts in local runtime unless explicitly overridden.
