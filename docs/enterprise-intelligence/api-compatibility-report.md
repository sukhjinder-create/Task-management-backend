# API Compatibility Report

Date: 2026-06-24

## Existing Dashboard APIs

`/dashboard/overview` remains available and returns the same broad dashboard contract:

- role
- month
- scope
- counts
- myTasks
- scoreCard
- dimensions
- trend
- analytics
- topOverdue
- projectHealth
- healthScore
- executiveSummary

`scoreCard.source` is now `enterprise_intelligence`.

`visualizations.charts` provides role-aware line and bar chart configs backed by intelligence repositories and snapshots.

## Existing Intelligence APIs

The following routes remain:

- `/intelligence/user/performance`
- `/intelligence/user/trend`
- `/intelligence/user/project-performance`
- `/intelligence/workspace/health`
- `/intelligence/projects/health`
- `/intelligence/team/comparison`
- `/intelligence/workspace/dashboard`

## New Enterprise APIs

Added:

- `GET /intelligence/unified/snapshot`
- `GET /intelligence/unified/history`

`/intelligence/unified/history` supports 7 days, 30 days, 90 days, 6 months, 1 year, and custom date ranges from snapshot rows without recalculation.

## Realtime Compatibility

Existing workspace socket events remain available. `workspace:health-pulse` now emits the stored enterprise workspace intelligence score and does not trigger legacy `workspace_health` calculations.

## Error Compatibility

If enterprise tables are not installed, changed intelligence routes return `503` with a clear migration message.

## Security

The new routes preserve existing auth and workspace checks. User history access is scoped to self unless admin.
