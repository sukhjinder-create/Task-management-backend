# Asystence Superadmin Platform Intelligence Report

**Date:** 2 July 2026  
**Dashboard:** Superadmin Adaptive Intelligence Evaluation  
**Route:** `/superadmin/adaptive-intelligence`

## Purpose

The superadmin dashboard measures platform-level adaptive intelligence quality across workspaces without exposing customer data.

## Visibility

Frontend:

- Added to the Superadmin Platform Console as `Adaptive Intelligence`.
- Uses the existing protected superadmin layout.

Backend:

- Mounted at `/superadmin/adaptive-intelligence`.
- Protected by `requireSuperadmin`.
- Does not require or expose workspace-scoped user sessions.

## Tenant-safety contract

The platform dashboard returns aggregate-only values:

- active workspace count;
- evaluated recommendation count;
- average effectiveness;
- confidence calibration totals;
- strategy effectiveness by business category;
- capability contribution by business label;
- context contribution by business label;
- runtime totals and failure counts.

It intentionally excludes:

- workspace names;
- workspace IDs;
- project names;
- task titles;
- meeting content;
- user names;
- customer-specific evidence.

## Dashboard sections

Implemented sections:

- platform adaptive impact;
- active workspace count;
- evaluated recommendations;
- runtime runs and failures;
- recommendation category effectiveness;
- capability contribution;
- context contribution;
- confidence calibration.

## Validation evidence

Frontend production build passed and generated:

- `SuperadminAdaptiveIntelligence-CGXFS7kO.js`, 7.11 kB minified / 2.33 kB gzip.

Backend endpoint is implemented in:

- `routes/superadminAdaptiveIntelligence.routes.js`
- `adaptive/evaluation/adaptiveIntelligenceEvaluation.service.js`

## Remaining platform telemetry gaps

The AIEP service currently aggregates available Adaptive Runtime evidence. AI provider latency, token usage, and provider cost require provider-level telemetry fields to be consistently available from production AI-service logs or an existing cost collector. No new AI calls were added.
