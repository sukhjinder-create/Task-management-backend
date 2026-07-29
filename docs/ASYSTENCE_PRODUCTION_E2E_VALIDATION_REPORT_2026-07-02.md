# Asystence Production E2E Validation Report

**Date:** 02 July 2026  
**Backend revision:** `asystence-api-00292-2kp`  
**AI revision:** `asystence-ai-00006-4xh`  
**Frontend deployment:** `dpl_3NmXdEN7ds4TThMEUduMS7J6jBMs`

## Final E2E summary

| Metric | Result |
|---|---:|
| Checks total | 42 |
| Checks passed | 42 |
| Checks failed | 0 |
| Critical failed | 0 |

## Covered flows

- Public backend version/app metadata.
- AI health/readiness.
- Authenticated `auth.me`.
- Workspace plan.
- Dashboard overview.
- Executive Summary.
- Workspace Intelligence.
- Huddles diagnostics.
- Meeting Intelligence diagnostics.
- Notifications.
- Billing summary.
- Autopilot settings.
- Testing Agent settings.
- Operations command center.
- Asana not-connected safe state.
- Adaptive settings and capability registry.
- Workspace AI settings.
- Project lifecycle create/read.
- Task lifecycle create/update/read.
- Adaptive event capture and replay.
- Adaptive workflow creation.
- Adaptive worker run-once.
- Recommendation generation.
- Approval rejection.
- Learning update.
- Workflow approval-pending state.
- AI meeting-notes task generation.
- AI-generated task risk.
- Chat channel create.
- AI-trigger chat message.
- Backend AI reply persistence.
- Chat message fetch.
- Workspace isolation header-forgery rejection.

## Timing notes

- Adaptive worker run-once: 3.896s in the final run.
- Backend AI reply persisted: 18.842s in the final run.
- AI `/ready`: 416ms in final E2E and independently verified with config/database/backend/provider checks.

## Verdict

Authenticated production E2E passed.

