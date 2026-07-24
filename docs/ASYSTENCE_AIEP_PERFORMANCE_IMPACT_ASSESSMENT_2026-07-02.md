# Asystence AIEP Performance Impact Assessment

**Date:** 2 July 2026  
**Scope:** Runtime, API, dashboard, and storage impact of AIEP  
**Verdict:** Low runtime risk by design; DB-backed latency measurement pending local/staging DB availability.

## Runtime impact

AIEP does not run inside the Adaptive Runtime recommendation path.

It does not:

- call LLMs;
- add synchronous reasoning work;
- change event processing;
- change workflow execution;
- change approval enforcement.

The primary runtime impact is dashboard-triggered materialization of recent evaluation snapshots.

## Query design

The workspace evaluator reads:

- `operations_ai_actions`;
- `adaptive_runtime_runs`;
- `adaptive_predictions`;
- `adaptive_learning_signals`;
- `operations_ai_action_decisions`;
- `adaptive_workflow_runs`;
- `adaptive_capability_invocations`;
- `adaptive_execution_plans`.

Limits are bounded:

- refresh limit defaults to 150;
- load limit is capped;
- platform dashboard reads at most 2000 recent evaluations;
- windows are bounded to 1–365 days.

## Indexes added

Migration adds indexes for:

- workspace/evaluated-at lookups;
- action lookup;
- recommendation category lookup;
- context JSONB search;
- metric snapshot recency.

## Frontend impact

New dashboard chunks are small and lazy-loaded:

- Workspace AI Impact: 8.45 kB minified / 2.73 kB gzip.
- Superadmin Adaptive Intelligence: 7.11 kB minified / 2.33 kB gzip.

No main dashboard or task page bundle was materially expanded by these pages.

## Known warnings

Existing frontend build warnings remain:

- outdated browsers data;
- large existing vendor chunks.

AIEP did not introduce a new large dependency.

## Pending measurement

DB-backed latency for `/adaptive/intelligence/dashboard` and `/superadmin/adaptive-intelligence/dashboard` is pending because local PostgreSQL was unavailable.

## Recommendation

Before pilot rollout, run the AIEP verifier and dashboard endpoints against staging with:

- at least 500 adaptive actions;
- at least 100 evaluated predictions;
- multiple workspaces;
- mixed accepted/rejected/pending recommendations.
