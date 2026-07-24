# Asystence Production Deployment Report

**Date:** 02 July 2026  
**Project:** `asystence-backend`  
**Region:** `asia-south1`

## Deployed repositories

| Surface | Commit SHA | Deployment |
|---|---:|---|
| Backend | `c4b3addbc0b21e242e7478f63d6a439a998cd3c2` | Cloud Run `asystence-api-00292-2kp`, 100% traffic |
| AI service | `4883c8beabc819cd8cd37bb37709a11fc4030f06` | Cloud Run `asystence-ai-00006-4xh`, 100% traffic |
| Frontend | `19fe9f901a7e782a6f723f6da451d65903015c87` | Vercel `dpl_3NmXdEN7ds4TThMEUduMS7J6jBMs`, aliased to `https://app.asystence.com` |
| Landing | `2d8eabd7e99c078d4c0b74a6b69a652c350d5efb` | Vercel `dpl_FmdGa9PP3nYw8gZsFzsJcavYkyaN`, aliased to `https://asystence.com` |

## Cloud Run evidence

| Service | Image | CPU / Memory | Min / Max scale | Secret refs | Raw secret-like env |
|---|---|---:|---:|---:|---:|
| `asystence-api` | `gcr.io/asystence-backend/asystence-api:c4b3addbc0b21e242e7478f63d6a439a998cd3c2` | 1 CPU / 1Gi | 1 / 100 | 31 | 0 |
| `asystence-ai` | `gcr.io/asystence-backend/asystence-ai:4883c8beabc819cd8cd37bb37709a11fc4030f06` | 1 CPU / 512Mi | 0 / 10 | 5 | 0 |

## Build evidence

| Service | Cloud Build ID | Status |
|---|---|---|
| Backend | `e63cc629-94b2-41cd-9cea-59c7ab883f2c` | Success |
| AI service | `668eff00-01ac-44bc-bd0a-150cca83e17b` | Success |

## Migration status

- Applied additive migration: `migrations/20260701_adaptive_enterprise_pilot_maturity.sql`.
- Added source runner: `run-adaptive-pilot-maturity-migration.js`.
- Production schema verified:
  - `adaptive_predictions.baseline_snapshot`
  - `adaptive_predictions.evaluation_strategy`
  - `adaptive_predictions.causal_summary`
  - `adaptive_causal_evaluations`
- Production adaptive verifier result:

```json
{
  "status": "ok",
  "migrationSqlTransactional": true,
  "tables": 9,
  "operationsColumns": 5,
  "workspaceEventColumns": 6,
  "capabilities": 8,
  "contextProviders": 7,
  "observers": 4
}
```

## Public endpoint smoke

| Endpoint | Result |
|---|---|
| Backend `/version` | HTTP 200, commit `c4b3addbc0b21e242e7478f63d6a439a998cd3c2` |
| Backend `/app-version` | HTTP 200 |
| AI `/health` | HTTP 200 |
| AI `/ready` | HTTP 200, ready=true |
| App frontend | HTTP 200 |
| Landing | HTTP 200 |
| Landing robots/sitemap | HTTP 200 |

