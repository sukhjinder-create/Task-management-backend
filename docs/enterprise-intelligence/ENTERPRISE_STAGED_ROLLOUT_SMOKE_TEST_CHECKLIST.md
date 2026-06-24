# Enterprise Intelligence Staged Rollout Smoke Test Checklist

Generated: 2026-06-24

Run this checklist for each target workspace and again for each mode transition: `legacy` -> `shadow` -> `unified`.

## Backend Controls

- [ ] `GET /intelligence/cutover/status` returns effective policy rows.
- [ ] `GET /intelligence/cutover/health` returns `healthy` or accepted `watch`.
- [ ] Target surface response includes all `X-Enterprise-Intelligence-*` headers.
- [ ] Payload includes `cutover.surface`, `cutover.mode`, and `cutover.selectedSource`.
- [ ] Rollback control can set target surface back to `legacy`.

## Admin Dashboard

- [ ] `GET /dashboard/overview` succeeds.
- [ ] `GET /dashboard/executive-detail` succeeds.
- [ ] Workspace health scorecard renders from backend payload.
- [ ] Productivity/risk/team/project charts render from `visualizations.charts`.
- [ ] No frontend score math is needed to draw charts.
- [ ] Existing layout, spacing, cards, typography, and navigation remain unchanged.

## Manager Dashboard

- [ ] `GET /dashboard/overview` succeeds for manager role.
- [ ] Assigned project performance charts render.
- [ ] Team delivery/risk trend charts render.
- [ ] Project comparison data is backend-provided.
- [ ] No dashboard UI derivation is introduced.

## User Dashboard

- [ ] `GET /dashboard/overview` succeeds for user role.
- [ ] `GET /intelligence/user/performance` succeeds.
- [ ] `GET /intelligence/user/trend` succeeds.
- [ ] `GET /intelligence/user/project-performance` succeeds.
- [ ] Personal performance/workload/delivery/task completion/risk trends render.

## Intelligence APIs

- [ ] `GET /intelligence/insights` succeeds for admin.
- [ ] `GET /intelligence/workspace/health` succeeds.
- [ ] `GET /intelligence/projects/health` succeeds.
- [ ] `GET /intelligence/team/comparison` declares derived comparison authority.
- [ ] `GET /intelligence/unified/snapshot` returns repository-backed current intelligence.
- [ ] `GET /intelligence/unified/history` returns snapshot-backed history.

## Attendance

- [ ] Attendance scores include `attendanceClosedThroughDate`.
- [ ] Current day is not treated as closed before attendance closeout.
- [ ] Approved leave and non-working days are not penalized.
- [ ] Non-working day recognition requires meaningful delivery.
- [ ] Burnout risk is visible for repeated overtime patterns.

## Rollback

- [ ] Set target surface to `legacy`.
- [ ] Re-call target endpoint.
- [ ] Verify header source is `legacy_scoring_rollback`.
- [ ] Verify dashboard still renders.
- [ ] Confirm no migration or data deletion was required.

## No-Go If Any Check Fails

Do not expand rollout until failures are resolved and the same surface passes in `shadow` again.
