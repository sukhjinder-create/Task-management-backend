# Enterprise Intelligence Time Model

Generated: 2026-06-24

## Canonical Fields

Every intelligence row returned to the UI must expose:

| Field | Meaning |
| --- | --- |
| `computedAt` | When this intelligence result was generated or snapshot captured. |
| `coverageStart` | First date included in the evidence window. |
| `coverageEnd` | Last date included in the evidence window. |
| `attendanceClosedThroughDate` | Last attendance day eligible for attendance scoring. |
| `snapshotDate` | Historical snapshot date, or `null` for live intelligence. |
| `intelligenceMode` | `live_operational` or `historical_snapshot`. |
| `time` | Object containing the same canonical fields for stable client consumption. |

## Live Operational Intelligence

Live rows come from:

- `user_intelligence`
- `project_intelligence`
- `team_intelligence`
- `workspace_intelligence`

Repository mapping:

- `computedAt` comes from `last_evaluated_at`.
- `coverageStart` and `coverageEnd` come from `source_window`.
- `attendanceClosedThroughDate` comes from `source_window.attendanceClosedThroughDate` or attendance metrics.
- `snapshotDate` is `null`.
- `intelligenceMode` is `live_operational`.

Task, project, collaboration, review, leave, time-log, and blocker signals may update near real time through the recalculation queue.

## Historical Snapshot Intelligence

Historical rows come from `intelligence_snapshots`.

Repository mapping:

- `computedAt` comes from `captured_at`.
- `coverageStart` and `coverageEnd` come from snapshot payload source window.
- `attendanceClosedThroughDate` comes from snapshot payload source window or attendance metrics.
- `snapshotDate` comes from `captured_for_date`.
- `intelligenceMode` is `historical_snapshot`.

Supported ranges:

- `30d`
- `90d`
- `6m`
- `1y`
- `all`
- `custom`

`all` reads the full available snapshot history and relies on dashboard chart bucketing to keep long-range visualizations readable.

Historical APIs read snapshots without recalculation.

## Attendance Closeout Rule

Attendance intelligence is not live-through-the-minute.

Attendance evidence is capped to the latest closed attendance day:

- `evidenceCollector.js` reads `MAX(date)` from `attendance_daily`.
- Attendance calendar and attendance rows are evaluated only through that closed date.
- If today has attendance events but the daily aggregation has not closed, today is not negatively scored.

The daily closeout sequence is:

1. `cron/attendance.cron.js` runs `aggregateDailyAttendance()`.
2. If aggregation succeeds, it calls `runAttendanceIntelligenceCloseout()`.
3. Closeout emits `attendance_day_closed`.
4. The unified engine recalculates impacted users, teams, and workspace aggregates.

## UI Contract

All dashboard and intelligence responses should display time metadata alongside scores so users can distinguish:

- current live operational intelligence
- historical snapshot intelligence
- attendance evidence that is closed through a prior date

No client should infer freshness from local time.
