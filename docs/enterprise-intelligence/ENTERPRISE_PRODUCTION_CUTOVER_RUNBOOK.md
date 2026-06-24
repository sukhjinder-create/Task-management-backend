# Enterprise Intelligence Production Cutover Runbook

Generated: 2026-06-24

## Scope

This runbook operates the staged cutover from legacy scoring output to enterprise intelligence repository output.

It does not redesign the intelligence model, remove legacy code, deploy infrastructure, or change environment variables.

## Preconditions

1. Enterprise intelligence base migration has already been applied.
2. Cutover control migration is applied:

```bash
npm run migrate:enterprise-intelligence-cutover-controls
```

3. Local verification passes:

```bash
npm run verify:enterprise-intelligence
npm run verify:enterprise-intelligence:real-data
```

4. `GET /intelligence/cutover/health` is `healthy` or an accepted `watch`.
5. Rollback decision owner is available during the rollout window.

## Control Modes

| Mode | User-facing source | Unified engine executed | Use case |
| --- | --- | --- | --- |
| `legacy` | Legacy rollback adapter | No | Default-safe state and rollback |
| `shadow` | Legacy rollback adapter | Yes | Compare unified behavior without changing users |
| `unified` | Enterprise intelligence repositories | Yes | Actual cutover |

If the control table is missing or no control row matches, core surfaces default to `legacy`.

## Change A Surface

Workspace-scoped control:

```http
POST /intelligence/cutover/controls
Content-Type: application/json

{
  "surface": "dashboard_overview",
  "mode": "shadow",
  "reason": "Canary workspace dashboard overview validation"
}
```

All core surfaces for a workspace:

```http
POST /intelligence/cutover/controls
Content-Type: application/json

{
  "surface": "all_core",
  "mode": "shadow",
  "reason": "Workspace-wide shadow validation"
}
```

Rollback:

```http
POST /intelligence/cutover/controls
Content-Type: application/json

{
  "surface": "all_core",
  "mode": "legacy",
  "reason": "Rollback after failed smoke check"
}
```

## Recommended Sequence

1. Confirm `legacy` mode:
   - call `GET /intelligence/cutover/status`
   - verify each target surface resolves to `legacy`
2. Run smoke checklist in legacy mode.
3. Set one low-risk surface to `shadow`.
4. Verify headers:
   - `X-Enterprise-Intelligence-Mode: shadow`
   - `X-Enterprise-Intelligence-Source: legacy_scoring_rollback`
5. Watch server logs for `[enterprise-intelligence-cutover]` observations.
6. Run smoke checklist again.
7. Set the same surface to `unified`.
8. Verify headers:
   - `X-Enterprise-Intelligence-Mode: unified`
   - `X-Enterprise-Intelligence-Source: enterprise_intelligence`
9. Monitor health for at least one business day.
10. Repeat by surface or workspace.

## Immediate Rollback Triggers

Set the affected surface or `all_core` to `legacy` if any of these occur:

- dashboard payload missing core scorecards
- `cutover/health` becomes `attention_required`
- failed recalculation events increase and do not recover
- repository completeness drops below expected users/projects/workspace row counts
- stale rows exceed the accepted window
- dashboard charts disappear or show malformed schema
- user, manager, or admin dashboard errors increase

## No-Go Rules

Do not move from `shadow` to `unified` when:

- shadow execution is throwing errors
- the unified response lacks `computedAt`, coverage fields, or explainability
- snapshots are stale or missing for required historical views
- attendance is expected to be current but `attendanceClosedThroughDate` has not reached the prior business day
- non-core `legacy_isolated_non_core` payloads are being counted as dashboard cutover success

## Recovery Notes

Rollback does not delete intelligence rows and does not stop recalculation. It only changes the user-facing source for cutover-aware core endpoints.

After rollback, leave the queue running, inspect diagnostics, repair repository or recalculation issues, and re-enter `shadow` before trying `unified` again.
