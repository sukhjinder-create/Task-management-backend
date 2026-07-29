# Asystence Regression Certification Report

**Date:** 02 July 2026  
**Scope:** Backend, frontend, AI service, landing, production E2E

## Local regression gates

| Surface | Command/check | Result |
|---|---|---|
| Backend | `npm run test:adaptive-runtime` | Passed 10/10 |
| Backend | `npm audit --audit-level=high` | Passed high/critical gate; 8 moderate Firebase chain findings remain |
| Backend | `node --check run-adaptive-pilot-maturity-migration.js` | Passed |
| Backend | `git diff --check` | Passed for release files; unrelated `.claude` line-ending warning remains local |
| Frontend | `npm run build` | Passed locally and on Vercel |
| Frontend | Vercel production build | Passed, deployment `dpl_3NmXdEN7ds4TThMEUduMS7J6jBMs` |
| Landing | `npm run build` | Passed; sitemap generated with 57 URLs |
| AI service | syntax checks + `npm audit --audit-level=high` | Passed; 0 vulnerabilities |

## Production regression gates

| Flow group | Result |
|---|---|
| Authentication/session | Passed |
| Workspace access/isolation | Passed |
| Dashboard/executive/workspace intelligence | Passed |
| Huddles/Meeting Intelligence diagnostics | Passed |
| Project/task lifecycle | Passed |
| Adaptive runtime/workflow/approval/learning | Passed |
| AI task generation and chat reply persistence | Passed |
| Notifications/billing/integrations safe state | Passed |

## Known non-blocking warnings

- Frontend LiveKit vendor chunk remains ~525.65KB minified / 137.52KB gzip.
- Browserslist/baseline browser metadata is stale.
- Backend Firebase Admin moderate dependency chain requires Node 22-era upgrade.

## Verdict

Regression certification passed for controlled rollout.

