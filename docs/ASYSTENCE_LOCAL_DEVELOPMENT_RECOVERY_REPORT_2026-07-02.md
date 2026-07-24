# Asystence Local Development Recovery Report

**Date:** 02 July 2026  
**Scope:** Backend, frontend, AI service, landing local-development safety  
**Status:** Local configuration recovered; live local runtime smoke is operator-blocked by Docker Desktop/service availability.

## Executive summary

The local development configuration was audited to ensure it no longer points accidentally at production services. Backend, frontend, and AI local configuration now resolve to localhost or emulator-safe addresses, while production-domain references are limited to deny-list/runtime guards or deployment configuration.

Live local end-to-end smoke could not be completed because Docker Desktop / the Docker service was not running and could not be started from this shell without operator-level desktop/admin action.

## Evidence

| Area | Evidence | Result |
|---|---|---|
| Backend local env | `.env` uses localhost API/database targets and `DB_SSL=false`. | Passed static recovery. |
| Frontend local env | `src/.env` uses `http://localhost:5000`; `.env.mobile` uses `http://10.0.2.2:5000`. | Passed static recovery. |
| AI local env | AI `.env` was changed to local DB/backend/provider defaults. | Passed static recovery. |
| Production-domain scan | Backend: only `utils/databaseSafety.js` production DB deny-list. Frontend: only `src/config/runtime.js` production-domain detector. AI: no production hardcoding found in runtime source. | Passed static scan. |
| Docker runtime | `docker compose` failed because Docker daemon was unavailable; `Start-Service com.docker.service` failed from this shell. | Operator-blocked. |

## Code/config changes completed

- Frontend now resolves API/socket URLs through `src/config/runtime.js`.
- Local browser sessions refuse production API URLs unless explicitly allowed via `VITE_ALLOW_LOCAL_PRODUCTION_API=true`.
- Electron build no longer hardcodes the production backend URL.
- AI service local `.env` was corrected to local backend/database defaults.

## Remaining local operator action

Start Docker Desktop or the Docker service, then run local runtime validation:

```powershell
docker compose -f docker-compose.local.yml up -d postgres
npm run dev
```

Then run frontend and AI local smoke against localhost.

## Verdict

Local-development configuration is recovered. Live local smoke remains blocked by workstation Docker availability, not by a discovered code defect.

