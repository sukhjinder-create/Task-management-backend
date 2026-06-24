# Enterprise Intelligence Production Go/No-Go Package

Generated: 2026-06-24

## Decision

Go for staged production cutover only.

No-go for broad big-bang production replacement.

## Go Conditions

- Cutover controls migration installed.
- Health endpoint is `healthy` or accepted `watch`.
- Smoke checklist passes in `legacy`.
- Shadow mode runs without user-facing regression.
- Unified mode passes on one surface or workspace before wider rollout.
- Rollback to `legacy` is tested.
- Live/staging DB validation is completed before broad rollout.

## No-Go Conditions

- `cutover/health` returns `attention_required`.
- Missing repository rows for active users, active projects, or workspace intelligence.
- Failed recalculation events persist.
- Historical snapshots are missing for required trend ranges.
- Dashboard payload schema changes break existing cards or charts.
- Non-core legacy surfaces are mixed into core dashboard cutover metrics.
- Rollback control fails.

## Rollback Command

Use workspace-scoped rollback:

```http
POST /intelligence/cutover/controls
Content-Type: application/json

{
  "surface": "all_core",
  "mode": "legacy",
  "reason": "Production rollback"
}
```

## Evidence Artifacts

- `ENTERPRISE_PRODUCTION_READINESS_REPORT.md`
- `ENTERPRISE_PRODUCTION_CUTOVER_MATRIX.md`
- `ENTERPRISE_LEGACY_NON_CORE_CUTOVER_PROOF.md`
- `ENTERPRISE_REAL_DATA_SHADOW_VALIDATION.md`
- `ENTERPRISE_PRODUCTION_CUTOVER_RUNBOOK.md`
- `ENTERPRISE_POST_CUTOVER_MONITORING_GUIDE.md`
- `ENTERPRISE_STAGED_ROLLOUT_SMOKE_TEST_CHECKLIST.md`

## Final Recommendation

Start with one workspace and one low-risk dashboard surface in `shadow`.

Do not advance to workspace-wide `unified` until the first surface has passed smoke checks, health checks, and rollback verification.
