# Asystence Universal Explainability Report

**Date:** 2 July 2026  
**Scope:** Universal adaptive explanation interface  
**Status:** Implemented locally.

## Purpose

Every adaptive recommendation can now expose a consistent business-language explanation.

The explanation answers:

- why this was recommended;
- which context influenced it;
- which historical behaviour influenced it;
- which learning signals influenced it;
- how confident the system is;
- what business outcome is expected;
- which similar historical situations were considered;
- what changed after previous feedback;
- whether the recommendation would change today.

## Implementation

Backend:

- `adaptive_universal_explanations`
- `GET /adaptive/explain/recommendation/:id`
- `GET /adaptive/explain?entityType=task&entityId=...`

Frontend:

- `AdaptiveRecommendations` now includes an `Explain` action.
- The explanation appears contextually inside existing recommendation cards.

## Security and UX constraints

The explainability layer:

- uses existing JWT and workspace middleware;
- respects user/manager/admin recommendation visibility;
- does not expose raw prompts;
- does not expose internal workflow IDs;
- redacts internal capability keys in visible output;
- speaks in business language.

## Validation evidence

`npm run test:final-intelligence-completion` passed.

The explainability test verifies:

- required answer sections are present;
- internal keys such as `notification.send` are not visible;
- internal feedback keys such as `recommendation.accepted` are not visible.

## Integration coverage

Current implementation supports contextual explanation for:

- adaptive recommendations;
- task-scoped recommendations;
- project-scoped recommendations.

The same API contract can be reused by Meetings, Executive Summary, Workspace Intelligence, Approvals, and AI Chat surfaces.
