# Asystence Workspace Admin AIEP Dashboard Report

**Date:** 2 July 2026  
**Dashboard:** Workspace Admin AI Impact  
**Route:** `/admin/adaptive-intelligence`

## Purpose

The workspace admin dashboard explains whether Adaptive Intelligence is helping a workspace in business language.

It avoids internal event names, workflow IDs, capability keys, and engineering terminology in visible dashboard content.

## Visibility

Frontend:

- Visible to workspace admins through the existing sidebar as `AI Impact`.
- Route is protected with `allowedRoles={["admin"]}` and `requiredFeature="workspace_intelligence"`.

Backend:

- Protected by JWT and workspace middleware.
- Requires administrator role: `admin` or `owner`.
- Uses `req.workspaceId` for all data access.

## Dashboard sections

Implemented sections:

- headline answer: “Is Adaptive Intelligence helping?”
- average effectiveness;
- accepted/executed vs rejected/pending recommendations;
- runtime run health;
- successful recommendation strategies;
- capability contribution in business language;
- context contribution in business language;
- confidence calibration;
- recent explainability cards.

## Business language examples

Internal keys are translated into labels such as:

- Notify the right people
- Create follow-up work
- Capture organizational memory
- Refresh executive visibility
- Run quality checks
- Meeting follow-through
- Delivery risk management
- Task delivery assistance

## Explainability

Recent recommendation cards answer:

- what was recommended;
- why it was recommended;
- what context influenced it;
- whether outcomes improved;
- whether the system would recommend it again;
- what learning changed.

## Validation evidence

Frontend production build passed and generated:

- `AdaptiveIntelligenceEvaluation-DuqvtDLx.js`, 8.45 kB minified / 2.73 kB gzip.

Backend unit tests verify:

- business-language evaluation records are produced;
- visible payloads do not expose `notification.send`;
- visible payloads do not expose `recommendation.accepted`;
- effectiveness scores are bounded between 0 and 1.

## Limitation

Live dashboard population was not DB-verified because local PostgreSQL was unavailable and Docker Desktop was not running.
