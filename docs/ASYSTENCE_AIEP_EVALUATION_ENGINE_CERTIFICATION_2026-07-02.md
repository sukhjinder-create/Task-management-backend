# Asystence AIEP Evaluation Engine Certification

**Date:** 2 July 2026  
**Certification scope:** AIEP service, schema artifact, routes, tests, and UI build  
**Verdict:** Code-certified locally; DB-backed verification blocked by local infrastructure.

## What was certified

Implemented:

- action-level evaluation records;
- effectiveness scoring;
- confidence calibration;
- context contribution labeling;
- capability contribution labeling;
- business outcome dimensions;
- learning summaries;
- explainability summaries;
- workspace dashboard API;
- superadmin aggregate API;
- migration artifact;
- migration runner;
- verifier script.

## Test evidence

Command:

```powershell
npm run test:adaptive-intelligence-evaluation
```

Result:

- Passed, 4/4 tests.

Covered assertions:

- internal adaptive data is translated into business-language evaluation records;
- effectiveness scoring rewards accepted, accurate, completed outcomes;
- rejected/failed outcomes score lower;
- confidence calibration identifies overconfidence and false positives;
- context labels remain human-facing;
- capability labels remain human-facing;
- visible payload avoids internal keys such as `notification.send` and `recommendation.accepted`.

## Regression evidence

Command:

```powershell
npm run test:adaptive-runtime
```

Result:

- Passed, 10/10 tests.

This verifies the Adaptive Runtime and Orchestrator behaviour remains unchanged.

## Build evidence

Frontend command:

```powershell
npm run build
```

Result:

- Passed.

## DB-backed verifier status

Command:

```powershell
npm run verify:adaptive-intelligence-evaluation
```

Result:

- Blocked by local PostgreSQL availability.
- Target was local: `localhost:5432/asystence_dev`.
- Failure: `ECONNREFUSED`.

Docker attempt:

```powershell
docker compose -f docker-compose.local.yml up -d postgres
```

Result:

- Failed because Docker Desktop/Linux engine was unavailable.

## Certification verdict

AIEP is code-certified and build-certified locally.

DB-backed certification remains blocked until local PostgreSQL or Docker Desktop is available.
