# Performance Impact Report

Date: 2026-06-24

## Incremental Strategy

The platform no longer depends on monthly batch scoring for current dashboards. Events queue targeted recalculation for impacted entities only.

## Realtime Events

Near-real-time recalculation is queued for:

- task created
- task updated
- task completed
- task reassigned
- comment added
- blocker added
- blocker resolved
- leave approved
- review submitted
- project status changed
- time log added/deleted
- task estimation changed
- milestone completed
- sprint assignment changed
- integration execution signal observed

## Attendance

Attendance recalculates at end-of-day after `attendance_daily` aggregation, per product requirement. This avoids noisy score churn during the workday and captures absences correctly.

## Snapshot Analytics

Historical analytics read `intelligence_snapshots` and do not recalculate historical periods.

Supported windows:

- 7 days
- 30 days
- 90 days
- 6 months
- 1 year
- custom range

## Expected Impact

Normal event cost is bounded by impacted users/projects plus aggregate rows. Workspace-wide bootstrap remains available for migration, verification, and repair.

Integration execution events queue a workspace aggregate recalculation through the unified engine. They no longer write a separate `workspace_health` score.
