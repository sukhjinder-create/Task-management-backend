# Asystence Adaptive Experiments Report

**Date:** 2 July 2026  
**Scope:** Controlled adaptive strategy experiments  
**Status:** Implemented locally; schema application pending DB availability.

## Purpose

Adaptive Experiments compare strategies over time using measured AIEP outcomes.

Supported experiment scopes:

- workspace;
- department;
- pilot;
- platform/global aggregate.

## Implementation

Backend:

- `adaptive_strategy_experiments`
- `adaptive_strategy_experiment_results`
- `GET /adaptive/intelligence/experiments`
- `POST /adaptive/intelligence/experiments`
- `POST /adaptive/intelligence/experiments/:id/evaluate`
- `PATCH /adaptive/intelligence/experiments/:id/status`
- superadmin aggregate equivalents under `/superadmin/adaptive-intelligence/experiments`

Frontend:

- Workspace AI Impact page includes a compact Adaptive Experiments panel.
- The UI can create a strategy comparison from measured top categories and evaluate it.

## Experiment evaluation

Variants are matched against AIEP evaluation records by business-facing filters:

- recommendation category;
- capability label;
- context label;
- approval approach.

Supported primary metrics:

- effectiveness;
- adoption;
- approval efficiency;
- delivery.

## Statistical caution

The evaluator only recommends a winning strategy when:

- every variant meets `minimum_sample_size`;
- winner delta exceeds `meaningful_delta`;
- evidence comes from measured AIEP records.

If evidence is insufficient, the result explicitly says no strategy should be promoted yet.

## Validation evidence

`npm run test:final-intelligence-completion` passed.

The experiment test verifies:

- no winner is recommended with weak evidence;
- a winner is recommended only when both variants have enough samples and a meaningful delta.

## Behaviour impact

Experiments do not automatically change Adaptive Runtime behaviour. They produce auditable evidence for future strategy decisions.
