# Enterprise Intelligence Source Of Truth Audit

Generated: 2026-06-24  
Scope: active backend routes and frontend dashboard consumers that display workspace, user, project, team, attendance, performance, risk, trend, or analytics scores.

## Authoritative Source

The authoritative enterprise intelligence repositories are:

- `user_intelligence`
- `project_intelligence`
- `team_intelligence`
- `workspace_intelligence`
- `intelligence_snapshots`
- `intelligence_recalculation_events`

In `unified` cutover mode, the active dashboard service delegates to `intelligence/analytics/unifiedDashboard.adapter.js`. The adapter reads current rows through `getUnifiedIntelligenceSnapshot()` and historical rows through `getHistoricalSeries()`.

In `legacy` and `shadow` cutover modes, active core endpoints may use explicit rollback adapters. These are controlled by `enterprise_intelligence_cutover_controls`, surfaced in response headers and payload metadata, and are not silent fallback formulas.

## What Changed In This Hardening Pass

- `services/dashboard.service.js` remains a compatibility adapter only. It does not compute scores.
- `services/dashboard.service.js` is now cutover-aware. It routes to unified repositories, shadow mode, or explicit legacy rollback adapters based on the cutover policy.
- `intelligence/intelligence.controller.js` delegates response shaping to `intelligence/analytics/intelligenceResponses.service.js`.
- `intelligence/intelligence.controller.js` is now cutover-aware for core dashboard/intelligence surfaces, but still does not compute scores inline.
- `cron/monthlyIntelligence.cron.js` no longer imports or calls legacy monthly scoring jobs. It captures repository-backed snapshots only.
- `intelligence/analytics/unifiedDashboard.adapter.js` no longer derives fallback bands or risk values from overall scores.
- `src/pages/Dashboard.jsx` no longer exposes the old attendance/productivity weighting copy.
- The local verifier now blocks reintroduction of dashboard score formulas, legacy monthly cron calls, missing time metadata, and chart fallback score paths.

## Staged Cutover Addendum

The endpoint audit below proves the unified source-of-truth path. The production cutover layer adds a separate operational concern:

- `legacy` mode returns explicit rollback output and marks it with `legacy_scoring_rollback`.
- `shadow` mode returns legacy output while running unified intelligence for observation.
- `unified` mode returns enterprise repository output.
- cutover-aware responses include `X-Enterprise-Intelligence-*` headers and `cutover` payload metadata.
- rollback adapters live under `intelligence/legacy/` and are the only approved legacy score path during staged cutover.

## Endpoint Audit

| Endpoint | Controller / Service | Repository Source | Inline Score Computed | Legacy Table Read | Fallback / Alternate Score Path | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /dashboard/overview` | `routes/dashboard.routes.js` -> `services/dashboard.service.js` -> `unifiedDashboard.adapter.js` | `workspace_intelligence`, `user_intelligence`, `project_intelligence`, `team_intelligence`, `intelligence_snapshots` | No score generation. Operational counts only. | No | No score fallback after this pass | Migrated |
| `GET /dashboard/executive-detail` | Same dashboard path | Same as above | No | No | No | Migrated |
| `GET /operations/command-center` | `operationsCommandCenter.service.js` -> `getDashboardOverview()` | Same as dashboard overview | No score generation | No | No | Migrated |
| `GET /operations/daily-os` | `operationsCommandCenter.service.js` -> `getDashboardOverview()` | Same as dashboard overview | No score generation | No | No | Migrated |
| `GET /intelligence/user/performance` | `intelligence.controller.js` -> `buildUserPerformanceResponse()` | `user_intelligence` through snapshot engine | No controller formula | No | No | Migrated |
| `GET /intelligence/user/trend` | `buildUserTrendResponse()` | `intelligence_snapshots` | No | No | No | Migrated |
| `GET /intelligence/user/project-performance` | `buildUserProjectPerformanceResponse()` | `project_intelligence` | No | No | No | Migrated |
| `POST /intelligence/admin/run-monthly-scoring` | `runMonthlyScoring()` | New `bootstrapWorkspaceIntelligence()` | No legacy monthly score call | No | Route name is legacy-compatible only | Migrated |
| `GET /intelligence/insights` | `buildAdminInsightsResponse()` | Unified snapshot plus snapshots | Derived summaries from repository rows only | No | No score fallback | Migrated |
| `GET /intelligence/admin/executive-summary` | `buildExecutiveSummaryData()` | Unified snapshot plus snapshots | No enterprise score formula | No enterprise legacy score table | OKR health moved to isolated `legacyContext`; not consumed as core prompt signal | Migrated |
| `GET /intelligence/admin/coaching-effectiveness` | `buildCoachingEffectivenessResponse()` | `user_intelligence` | Counts/trends only | No | No | Migrated |
| `GET /intelligence/workspace/health` | `buildWorkspaceHealthResponse()` | `workspace_intelligence` | No | No | No | Migrated |
| `GET /intelligence/projects/health` | `buildProjectsHealthResponse()` | `project_intelligence` | No score generation | No | No | Migrated |
| `GET /intelligence/team/comparison` | `buildTeamComparisonResponse()` | `user_intelligence`, with `team_intelligence` reference metadata | No score generation | No | Explicit `derived_user_comparison`; `authority.teamScoreAuthority = false`; canonical team authority remains `team_intelligence` | Migrated as derived comparison |
| `GET /intelligence/workspace/dashboard` | `buildWorkspaceDashboardResponse()` | `workspace_intelligence` plus operational task/autopilot counts | No enterprise score formula | No | Operational completion rate is not an intelligence score | Migrated |
| `GET /intelligence/unified/snapshot` | `getUnifiedSnapshot()` | All enterprise repositories | No | No | No | Migrated |
| `GET /intelligence/unified/history` | `buildUnifiedHistoryResponse()` | `intelligence_snapshots` | No | No | No | Migrated |
| `GET /intelligence/goals/health` | `computeGoalWorkspaceHealth()` + `withLegacyIsolation()` | `okr_objectives` | Yes, OKR health | No enterprise legacy score table | Explicit `legacy_isolated_non_core`, excluded from enterprise cutover authority | Intentionally isolated |
| `GET /intelligence/enterprise/profitability-oracle` | `enterpriseIntelligence.service.js` + `withLegacyIsolation()` | Tasks/projects direct DB | Yes, specialty project risk/profit formulas | No monthly score table | Explicit `legacy_isolated_non_core`, excluded from core dashboards | Intentionally isolated |
| `GET /intelligence/enterprise/resignation-radar` | `enterpriseIntelligence.service.js` + `withLegacyIsolation()` | Users/tasks/attendance/comments direct DB | Yes, specialty risk formula | No monthly score table | Explicit `legacy_isolated_non_core`, excluded from core dashboards | Intentionally isolated |
| `GET /intelligence/enterprise/ghost-work` | `enterpriseIntelligence.service.js` + `withLegacyIsolation()` | Users/tasks/attendance direct DB | Yes, specialty ghost score formula | No monthly score table | Explicit `legacy_isolated_non_core`, excluded from core dashboards | Intentionally isolated |
| `GET /intelligence/enterprise/org-truth-map` | `enterpriseIntelligence.service.js` + `withLegacyIsolation()` | Users/tasks/comments direct DB | Yes, specialty value/archetype formula | No monthly score table | Explicit `legacy_isolated_non_core`, excluded from core dashboards | Intentionally isolated |
| `GET /reviews/user-context/:userId` | `routes/reviews.routes.js` | `user_intelligence` | No | No | No | Migrated |
| `GET /reviews/cycles/:cycleId/summary` | `routes/reviews.routes.js` | `performance_reviews` | Review rating averages only | No enterprise legacy score table | Not enterprise intelligence score | Out of scope |
| `GET /admin/attendance` | `adminAttendance.routes.js` | `attendance_daily` | No intelligence score | No | Operational attendance data only | Out of scope |
| `POST /admin/attendance/recalculate` | `adminAttendanceRecalculate.routes.js` | Rebuilds `attendance_daily` | No intelligence score | No | Attendance evidence producer | Out of scope |
| `GET /admin/attendance/export` | `adminAttendanceExport.routes.js` | `attendance_daily` | No intelligence score | No | Export only | Out of scope |
| `GET /ai-features/tasks/:taskId/risk` | `aiFeatures.service.js` + `withLegacyIsolation()` | Tasks direct DB | Yes, task-level AI risk | No monthly score table | Explicit `legacy_isolated_non_core`, excluded from enterprise cutover authority | Intentionally isolated |

## Active Cron / Producer Audit

| Producer | Before | Now | Status |
| --- | --- | --- | --- |
| `cron/monthlyIntelligence.cron.js` | Called `generateMonthlyScore()`, `generateMonthlyCoaching()`, `generateAdminInsights()`, and legacy monthly tables | Captures `intelligence_snapshots` from current enterprise repositories and records `scheduled_intelligence_snapshot` | Migrated |
| `cron/attendance.cron.js` | Attendance aggregation only | Aggregates daily attendance, then triggers `attendance_day_closed` recalculation after day closeout | Migrated |
| Task/comment/time/review/leave/project events | Mixed live and batch behavior | Queue impacted recalculations through unified realtime queue | Migrated |

## Legacy Code Retained For Controlled Rollback

The following legacy files still exist for shadow comparison, rollback, and phased migration. They are not called by the monthly cron and must not be used as hidden dashboard fallbacks. During staged cutover, they may be reached only through the explicit rollback adapters and cutover policy:

- `events/scoring/monthlyScoring.service.js`
- `events/scoring/monthlyScore.store.js`
- `intelligence/manualScoring.service.js`
- `intelligence/intelligence.service.js`
- `intelligence/intelligence.repository.js`
- `events/admin/adminInsight.service.js`
- `events/coaching/coachingScheduler.service.js`
- `events/coaching/coachingEffectiveness.service.js`

Approved rollback adapter files:

- `intelligence/legacy/legacyDashboard.adapter.js`
- `intelligence/legacy/legacyIntelligence.adapter.js`

## Final Source-Of-Truth Status

- Dashboard service: cutover-aware; unified mode is repository-backed, legacy/shadow modes are explicit rollback operations.
- Dashboard routes/controllers: migrated.
- Intelligence controller: cutover-aware for enterprise user/project/team/workspace routes; no inline score calculation.
- Frontend dashboard component: no score-generation formulas; renders backend data and visual states.
- Active monthly cron: migrated to snapshot-only.
- Remaining non-core legacy paths are now explicitly isolated with `legacy_isolated_non_core` cutover metadata. They remain reachable for their modules, but they are not dashboard-eligible and are not authoritative enterprise intelligence sources.
- Production cutover is no longer blocked locally. Real-data shadow validation completed against the representative seeded workspace fallback because the configured DB host remains unreachable.
