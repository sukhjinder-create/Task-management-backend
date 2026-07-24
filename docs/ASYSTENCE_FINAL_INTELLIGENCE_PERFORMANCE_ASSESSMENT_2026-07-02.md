# Asystence Final Intelligence Performance Assessment

**Date:** 2 July 2026  
**Scope:** Coach, Experiments, Memory Evolution, Universal Explainability  
**Verdict:** Low runtime-path impact by design.

## Runtime path impact

The final intelligence layer does not run inside the core recommendation generation path.

It executes through:

- admin dashboard requests;
- superadmin dashboard requests;
- explicit experiment evaluation;
- explicit memory pattern discovery;
- explicit explanation requests.

## Heavy work controls

Implemented safeguards:

- bounded evaluation windows;
- bounded query limits;
- minimum sample thresholds;
- no AI provider calls;
- no model training;
- no synchronous workflow execution changes.

## Frontend build impact

Relevant chunks after build:

- `AdaptiveIntelligenceEvaluation-9f0CE1pc.js`: 14.78 kB minified / 3.93 kB gzip.
- `SuperadminAdaptiveIntelligence-BQ8hwwcI.js`: 8.37 kB minified / 2.59 kB gzip.
- `AdaptiveRecommendations-CjAg5x64.js`: 8.50 kB minified / 2.68 kB gzip.

Existing large vendor chunk warnings remain unrelated to this implementation.

## Pending performance validation

DB-backed endpoint latency could not be measured locally because PostgreSQL was unavailable.

Recommended staging checks:

- `/adaptive/intelligence/coach`
- `/adaptive/intelligence/experiments/:id/evaluate`
- `/adaptive/intelligence/memory-patterns/discover`
- `/adaptive/explain/recommendation/:id`
- `/superadmin/adaptive-intelligence/coach`

Run with at least 1,000 evaluation rows and multiple workspaces.
