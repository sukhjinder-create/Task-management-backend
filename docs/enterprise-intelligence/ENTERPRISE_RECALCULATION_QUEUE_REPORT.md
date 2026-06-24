# Enterprise Recalculation Queue Report

Generated: 2026-06-24

## What Changed

The realtime recalculation path now uses a hardened queue in:

- `intelligence/realtime/recalculation.service.js`
- `intelligence/engine/unifiedIntelligence.engine.js`

## Queue Safeguards

| Requirement | Implementation |
| --- | --- |
| Deduplication | Stable dedupe key built from workspace, reason, source, users, projects, and managers. |
| Idempotency | Repeated matching events merge into one pending job. Repository writes use upserts. |
| Coalescing | Jobs wait `COALESCE_DELAY_MS = 750` before processing. |
| Retry safety | Failed jobs retry up to `MAX_ATTEMPTS = 3` with backoff. |
| Partial failure recovery | Per-user, per-project, and per-team failures are captured and recorded. |
| Stale aggregate prevention | Workspace aggregate is not refreshed after partial child recalculation failure. |
| Diagnostics | `getRecalculationQueueDiagnostics()` exposes pending count and keys. |

## Partial Failure Behavior

The unified engine recalculates impacted entities in this order:

1. Users
2. Projects
3. Teams
4. Workspace

If any user, project, or team recalculation fails:

- the failure is recorded in `intelligence_recalculation_events`
- status is `failed`
- error is `partial_recalculation_failed`
- metadata includes `staleAggregatePrevention`
- workspace aggregate refresh is skipped
- the queue retries the job

This prevents workspace intelligence from mixing fresh and stale child profiles.

## Event Coverage

The verifier confirms event names are wired for:

- `task_created`
- `task_updated`
- `task_completed`
- `task_reassigned`
- `comment_added`
- `blocker_added`
- `blocker_resolved`
- `attendance_day_closed`
- `leave_approved`
- `review_submitted`
- `project_status_changed`
- `time_log_added`
- `milestone_completed`

## Cron Behavior

The monthly cron is no longer a score producer. It now captures authoritative repository snapshots and records `scheduled_intelligence_snapshot`.

Attendance cron remains day-closeout based and triggers `attendance_day_closed` after daily aggregation.

## Verification Evidence

Command:

```bash
npm run verify:enterprise-intelligence
```

Verified:

- coalescing constants exist
- stable `dedupeKey` exists
- retry attempt metadata exists
- partial failure guard exists
- workspace aggregate stale prevention exists
- monthly cron does not call `generateMonthlyScore`
