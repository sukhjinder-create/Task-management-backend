# Enterprise Intelligence Post-Cutover Monitoring Guide

Generated: 2026-06-24

## Primary Health Endpoint

Use:

```http
GET /intelligence/cutover/health
```

Watch these fields:

- `status`
- `completeness.missing`
- `freshness.stale`
- `freshness.snapshotsLast7Days`
- `failures.recalculationFailures24h`
- `queue.pendingJobs`
- `queue.inFlightJobs`
- `queue.failedJobs`

## Expected Signals

| Signal | Healthy | Watch | Action |
| --- | --- | --- | --- |
| `status` | `healthy` | `watch` | Investigate stale rows or queue pressure before expanding rollout. |
| Missing workspace row | `0` | `1` | Do not cut over workspace surfaces. |
| Missing user/project rows | `0` | `> 0` | Recalculate impacted entities before expanding. |
| Stale rows | `0` after active recalculation | Any sustained stale count | Check queue and event ingestion. |
| Failed recalculations 24h | `0` | `> 0` | Keep or return affected surfaces to `legacy`. |
| Queue pending jobs | Low and draining | Growing | Pause rollout expansion. |

## Response Headers

Every cutover-aware response should include:

- `X-Enterprise-Intelligence-Mode`
- `X-Enterprise-Intelligence-Surface`
- `X-Enterprise-Intelligence-Source`
- `X-Enterprise-Intelligence-Policy`

For unified mode, expected source is:

```text
enterprise_intelligence
```

For rollback/shadow user-facing mode, expected source is:

```text
legacy_scoring_rollback
```

## Server Log Observation

The source switch logs structured observations with:

```text
[enterprise-intelligence-cutover]
```

Review:

- workspaceId
- surface
- mode
- selectedSource
- selected score summary
- chart count
- shadow score summary
- errors

## Attendance Monitoring

Attendance remains day-closeout based.

Operational checks:

- `attendanceClosedThroughDate` should normally equal the last closed working day.
- Current-day attendance gaps must not be treated as missing intelligence before closeout.
- Weekend/holiday work should show recognition only when meaningful delivery exists on the same day.
- Repeated overtime should appear as burnout risk visibility, not pure score uplift.

## Snapshot Monitoring

Historical analytics must read snapshots without recalculation.

Watch:

- `freshness.snapshotsLast7Days`
- `freshness.latestSnapshotCapturedAt`
- dashboard trend charts for empty series
- `intelligence_snapshots` capture failures in logs

## Escalation Path

1. Stop rollout expansion.
2. Set affected surface or `all_core` to `legacy`.
3. Capture `cutover/status` and `cutover/health`.
4. Capture one failing dashboard response including headers.
5. Inspect recalculation queue diagnostics.
6. Repair the impacted producer/repository path.
7. Re-enter `shadow` before `unified`.
