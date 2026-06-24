# Enterprise Production Cutover Matrix

Generated: 2026-06-24

## Decision Summary

Unified enterprise intelligence remains ready for staged production cutover on core dashboard surfaces.

This pass operationalizes the cutover. Core surfaces now support explicit rollout modes through `enterprise_intelligence_cutover_controls`:

- `legacy`: user-facing response comes from the legacy rollback adapter.
- `shadow`: user-facing response remains legacy while unified intelligence is executed and logged for comparison.
- `unified`: user-facing response comes from enterprise intelligence repositories.

Default mode is `legacy` if no control row exists or if the control table is not installed. This is deliberate rollback safety for staged production rollout.

## Operational Control Surface

| Endpoint | Purpose | Access | Source |
| --- | --- | --- | --- |
| `GET /intelligence/cutover/status` | Lists control rows and effective policies per core surface | Admin + existing advanced analytics gate | `enterprise_intelligence_cutover_controls` |
| `GET /intelligence/cutover/health` | Reports repository completeness, stale rows, queue health, failures, snapshots, isolated non-core surfaces | Admin + existing advanced analytics gate | Enterprise repositories plus queue diagnostics |
| `POST /intelligence/cutover/controls` | Sets `legacy`, `shadow`, or `unified` for a surface or `all_core` | Admin workspace-scoped; platform admin for global rows | `enterprise_intelligence_cutover_controls` |

Every cutover-aware core response sets:

- `X-Enterprise-Intelligence-Mode`
- `X-Enterprise-Intelligence-Surface`
- `X-Enterprise-Intelligence-Source`
- `X-Enterprise-Intelligence-Policy`

Object payloads also include `cutover` metadata.

## Core Cutover Surfaces

| Surface | API / UI | Unified Source | Rollback Source | Shadow Supported | Cutover Status |
| --- | --- | --- | --- | --- | --- |
| Admin dashboard overview | `GET /dashboard/overview` | Unified dashboard adapter over `workspace_intelligence`, `team_intelligence`, `project_intelligence`, `user_intelligence`, `intelligence_snapshots` | `legacyDashboard.adapter.js` over legacy monthly/health/task tables | Yes | Operationalized |
| Manager dashboard overview | `GET /dashboard/overview` | Same unified dashboard adapter | Same legacy rollback adapter | Yes | Operationalized |
| User dashboard overview | `GET /dashboard/overview` | Same unified dashboard adapter | Same legacy rollback adapter | Yes | Operationalized |
| Executive detail | `GET /dashboard/executive-detail` | Unified dashboard adapter | `legacyDashboard.adapter.js` | Yes | Operationalized |
| User performance | `GET /intelligence/user/performance` | `user_intelligence` via response builder | `intelligence.service.js` legacy adapter | Yes | Operationalized |
| User trend | `GET /intelligence/user/trend` | `intelligence_snapshots` | `intelligence.service.js` legacy adapter | Yes | Operationalized |
| User project performance | `GET /intelligence/user/project-performance` | `project_intelligence` | `intelligence.service.js` legacy adapter | Yes | Operationalized |
| Admin insights | `GET /intelligence/insights` | Unified snapshot plus snapshots | `intelligence.service.js` legacy adapter | Yes | Operationalized |
| Coaching effectiveness | `GET /intelligence/admin/coaching-effectiveness` | `user_intelligence` | `intelligence.service.js` legacy adapter | Yes | Operationalized |
| Workspace health | `GET /intelligence/workspace/health` | `workspace_intelligence` | `workspace_health` rollback adapter | Yes | Operationalized |
| Workspace dashboard | `GET /intelligence/workspace/dashboard` | `workspace_intelligence` plus operational counts | Legacy monthly/health/task adapter | Yes | Operationalized |
| Projects health | `GET /intelligence/projects/health` | `project_intelligence` | `workspace_project_monthly_scores` rollback adapter | Yes | Operationalized |
| Team comparison table | `GET /intelligence/team/comparison` | `user_intelligence` rows with `team_intelligence` authority metadata | `workspace_monthly_scores` rollback adapter | Yes | Operationalized as derived comparison |

## Unified-Only Utility Surfaces

| Surface | API | Source | Rollback Behavior | Status |
| --- | --- | --- | --- | --- |
| Unified current snapshot | `GET /intelligence/unified/snapshot` | All enterprise intelligence repositories | No legacy fallback. This endpoint exists to inspect the new source directly. | Ready |
| Unified history | `GET /intelligence/unified/history` | `intelligence_snapshots` | No legacy fallback. This endpoint exists to inspect snapshot history directly. | Ready |
| Review user context | `GET /reviews/user-context/:userId` | `user_intelligence` | No legacy fallback; review context is not a dashboard cutover switch. | Ready |
| Attendance closeout cron | `cron/attendance.cron.js` | Day-closeout attendance then enterprise recalculation | No immediate attendance recalculation. | Ready |
| Monthly intelligence cron | `cron/monthlyIntelligence.cron.js` | Snapshot capture from unified repositories | Legacy scoring code remains on disk but is not called by the cron. | Ready |

## Isolated Non-Core Surfaces

| Surface | API | UI Surface | Source | Core Dashboard Use | Cutover Status |
| --- | --- | --- | --- | --- | --- |
| OKR health | `GET /intelligence/goals/health` | OKR context only | `okr_objectives` formula | None | Intentionally excluded |
| Profitability oracle | `GET /intelligence/enterprise/profitability-oracle` | Enterprise Intelligence page | Direct project/task heuristics | None | Intentionally excluded |
| Resignation radar | `GET /intelligence/enterprise/resignation-radar` | Enterprise Intelligence page | Direct attendance/task/comment heuristics | None | Intentionally excluded |
| Ghost work | `GET /intelligence/enterprise/ghost-work` | Enterprise Intelligence page | Direct attendance/output heuristics | None | Intentionally excluded |
| Org truth map | `GET /intelligence/enterprise/org-truth-map` | Enterprise Intelligence page | Direct collaboration/output heuristics | None | Intentionally excluded |
| AI task deadline risk | `GET /ai-features/tasks/:taskId/risk`, `GET /ai-features/risks` | AI Features risk heatmap | Task-level helper heuristic | None | Intentionally excluded |

All intentionally excluded surfaces return `legacy_isolated_non_core` metadata and are not eligible for dashboard cutover success metrics.

## Cutover Recommendation

Outcome: safe for staged production cutover, not broad big-bang rollout.

Recommended sequence:

1. Install the cutover control migration.
2. Keep `all_core=legacy` until health and smoke checks pass.
3. Move one workspace or one low-risk surface to `shadow`.
4. Review headers, payload metadata, health diagnostics, and server cutover observations.
5. Move the same surface to `unified`.
6. Roll back immediately by setting the same surface or `all_core` to `legacy` if health or payload checks fail.
