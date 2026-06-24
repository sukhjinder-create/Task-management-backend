# Enterprise Attendance Hardening Report

Generated: 2026-06-24

## What Changed

Attendance is now a first-class intelligence domain, but it is evaluated only after daily attendance closeout. Sign-in/sign-off events do not immediately recalculate attendance scores.

Implemented files:

- `intelligence/engine/calendar.service.js`
- `intelligence/engine/evidenceCollector.js`
- `intelligence/evaluators/attendanceEvaluator.js`
- `intelligence/realtime/attendanceCloseout.service.js`
- `cron/attendance.cron.js`

## Working Day Awareness

Attendance evaluation uses `getWorkspaceCalendar()` and excludes negative scoring for:

- weekends
- workspace holidays
- approved leave days
- approved half-days through leave capacity
- scheduled non-working days

Sources:

- `workspace_work_schedule`
- `workspace_holidays`
- `leave_requests`

Only days with `expectedCapacity > 0` are evaluated as expected working days.

## Day-Closeout Enforcement

`collectUserEvidence()` now caps attendance evidence using:

- latest `attendance_daily.date` in the evaluation window
- `attendanceCoverage.startDate`
- `attendanceCoverage.endDate`
- `attendanceClosedThroughDate`

Task, project, collaboration, blocker, and review evidence can still update near real time. Attendance is evaluated through closed days only.

## Attendance Dimensions

The attendance evaluator produces:

- Presence Reliability
- Schedule Discipline
- Availability Quality
- Break Discipline
- Attendance Stability

Every attendance result includes:

- score
- confidence
- strengths
- concerns
- drivers
- metrics
- trend
- meaningful delivery rule

## Meaningful Delivery Rule

Non-working day attendance creates recognition only when the same day has meaningful delivery.

Meaningful delivery is true when at least one condition is met:

- `completedTasks > 0`
- `storyPoints > 0`
- `blockerResolutions > 0`
- `timeLogHours >= 2`

Trivial activity does not count. Examples that remain informational only:

- sign-in without delivery
- short idle session
- comment-only activity without delivery outcome
- time log below the 2 hour meaningful threshold

## Non-Working Day Rule

If a user attends on a non-working day:

- No penalty is applied.
- No automatic score increase is applied.
- Recognition appears only as exceptional contribution indicators.
- Indicators are capped at 3 per evaluation to avoid score inflation.

Recognition indicators are not direct score multipliers.

## Burnout Protection

Burnout signals are raised when the evaluator detects:

- repeated non-working day attendance
- sustained long days above 600 signed-in minutes
- longer hours with declining availability quality

Repeated overtime increases burnout visibility rather than inflating performance.

## Current Evidence

The local verifier confirms:

- attendance closeout is wired into cron
- immediate attendance event recalculation is not wired into `attendance.service.js`
- attendance evidence is capped to closed attendance days
- meaningful delivery threshold exists
- exceptional indicators are bounded
- no direct score inflation rule is documented in metrics

Command:

```bash
npm run verify:enterprise-intelligence
```

Result:

```text
Enterprise intelligence architecture verification passed
syntheticScore: 93
confidence: 98
attendanceScore: 94
indicators: 1
```
