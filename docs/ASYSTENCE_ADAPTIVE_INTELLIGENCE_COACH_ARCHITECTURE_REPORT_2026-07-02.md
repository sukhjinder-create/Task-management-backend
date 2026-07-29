# Asystence Adaptive Intelligence Coach Architecture Report

**Date:** 2 July 2026  
**Scope:** Adaptive Intelligence Coach  
**Status:** Implemented locally; DB-backed schema verification blocked by local PostgreSQL availability.

## Purpose

The Adaptive Intelligence Coach turns AIEP measurements into evidence-backed guidance. It does not generate generic AI advice and does not call an LLM.

It answers:

- what is working;
- what is weakening;
- which strategies need review;
- which context sources are useful;
- which confidence patterns are risky;
- what action should be taken and why.

## Implementation

Backend:

- `adaptive/evaluation/finalIntelligenceCompletion.service.js`
- `GET /adaptive/intelligence/coach`
- `GET /superadmin/adaptive-intelligence/coach`

Frontend:

- Workspace AI Impact page now includes `Adaptive Intelligence Coach`.
- Superadmin Adaptive Intelligence page now includes `Platform Adaptive Intelligence Coach`.

## Evidence model

Coach insights are derived from:

- `adaptive_intelligence_evaluations`;
- recommendation response status;
- effectiveness score;
- confidence calibration;
- context contribution;
- capability contribution;
- previous-window trend comparison.

The Coach produces:

- strengths;
- weaknesses;
- opportunities;
- trends;
- anomalies;
- recommended actions;
- expected business impact.

## Guardrails

The Coach does not:

- alter Adaptive Runtime behaviour;
- alter ranking;
- alter workflow execution;
- call AI providers;
- expose raw prompts;
- expose capability keys to workspace users.

## Validation evidence

Command:

```powershell
npm run test:final-intelligence-completion
```

Result:

- Passed, 4/4.

Covered:

- Coach insights include evidence.
- Coach guidance references measured acceptance/effectiveness/outcomes.
- Coach output includes expected business impact.

## Remaining blocker

DB-backed verifier could not complete because local PostgreSQL at `localhost:5432/asystence_dev` returned `ECONNREFUSED`.
