# Asystence Adaptive Intelligence Evaluation Architecture Report

**Date:** 2 July 2026  
**Scope:** Adaptive Intelligence Evaluation Platform (AIEP)  
**Verdict:** Implemented as an additive evaluation layer; production deployment remains unchanged.

## Executive summary

AIEP has been implemented as a measurement layer above the existing Adaptive Runtime and Adaptive Orchestrator. It does not redesign planning, reasoning, workflow execution, approval handling, or recommendation behaviour.

The platform now has code-level support to measure an adaptive action lifecycle from problem detection through context, reasoning, recommendation, response, workflow execution, business outcome, evaluation, learning, and future-behaviour evidence.

## Architecture

Existing platform layers remain the source of truth:

1. Adaptive Runtime observes operational events.
2. Context Platform builds evidence.
3. Reasoning Engine produces recommendations.
4. Approval and Execution Engines operate through existing services.
5. Learning Engine records feedback and outcome signals.
6. Existing Evaluation Engine records prediction accuracy and causal outcome deltas.
7. AIEP materializes business-facing evaluation records and dashboard aggregates.

## New backend components

| Component | Purpose |
|---|---|
| `adaptive/evaluation/adaptiveIntelligenceEvaluation.service.js` | Builds business-language evaluation records from existing adaptive actions, predictions, workflows, invocations, decisions, and learning signals. |
| `migrations/20260702_adaptive_intelligence_evaluation_platform.sql` | Adds AIEP evaluation and metric snapshot tables. |
| `run-adaptive-intelligence-evaluation-migration.js` | Applies the additive AIEP migration when explicitly run. |
| `scripts/verify-adaptive-intelligence-evaluation.js` | Validates migration safety/transactionality and business-language contracts when DB is available. |
| `routes/superadminAdaptiveIntelligence.routes.js` | Exposes aggregate-only superadmin platform intelligence. |

## New API endpoints

Workspace admin endpoints:

- `GET /adaptive/intelligence/dashboard`
- `POST /adaptive/intelligence/refresh`
- `GET /adaptive/intelligence/explain/:id`

Superadmin endpoint:

- `GET /superadmin/adaptive-intelligence/dashboard`

## Data model

New additive tables:

- `adaptive_intelligence_evaluations`
- `adaptive_intelligence_metric_snapshots`

The schema stores business evaluation snapshots, not new recommendation logic. It is tenant scoped with `workspace_id`, uses additive indexes, and enables row-level security.

## Behaviour preservation

AIEP does not:

- change recommendation ranking;
- change approval rules;
- execute workflows;
- call AI providers;
- retrain models;
- alter Adaptive Runtime behaviour;
- alter production deployment state.

It only reads existing adaptive evidence and writes evaluation snapshots.

## Evidence

Validated locally:

- `npm run test:adaptive-intelligence-evaluation` passed, 4/4.
- `npm run test:adaptive-runtime` passed, 10/10.
- Frontend `npm run build` passed.
- Backend changed-file syntax checks passed.

DB-backed verifier could not complete because local PostgreSQL was not running and Docker Desktop was unavailable.
